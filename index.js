const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('node:path');
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');


const app = express();
const port = Number(process.env.PORT) || 5000;
const authUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3000';

const catalog = require(path.join(__dirname, '../leebazz-client/public/leebazz-expanded-catalog.json'));

const productsById = new Map(
  catalog.products.filter((product) => product.isActive).map((product) => [product.id, product]),
);

const collectionNames = { cart: 'carts', wishlist: 'wishlists' };
const orderStatuses = [
  'pending_confirmation',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
];
const orderDateTimeZone = 'Asia/Dhaka';
const orderDatePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: orderDateTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const configuredDeliveryFee = Number.parseInt(process.env.DELIVERY_FEE_BDT, 10);
const deliveryFee = Number.isInteger(configuredDeliveryFee) && configuredDeliveryFee >= 0
  ? configuredDeliveryFee
  : 80;

const initializedIndexes = new Set();
let db;

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL is not configured in leebazz-server/.env');
}

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '32kb' }));

// MongoDB Connection Setup
const uri = process.env.MONGO_URL;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function getAuthenticatedUser(req) {
  const response = await fetch(`${authUrl}/api/auth/get-session`, {
    headers: { cookie: req.headers.cookie || '' },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const session = await response.json();
  return session?.user?.id ? session.user : null;
}

// Attach this middleware to every /api/admin route. Identity and role come
// from the Better Auth session cookie, never from client-supplied request data.
async function requireAdmin(req, res, next) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    req.authenticatedUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireCustomer(req, res, next) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
    req.authenticatedUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function addCalendarDays(date, days) {
  const dateParts = Object.fromEntries(
    orderDatePartsFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days, 12));
}

function serializeOrder(order) {
  const { _id, idempotencyKey, ...publicOrder } = order;
  return { ...publicOrder, id: _id.toString() };
}

async function clearPurchasedCartItems(userId, items) {
  if (!items.length) return;
  await db.collection(collectionNames.cart).deleteMany({
    userId,
    $or: items.map((item) => ({
      productId: item.productId,
      variantSku: item.variantSku || item.variant?.sku,
    })),
  });
}

async function releaseOrderInventory(orderId, items, restoreStock) {
  const reservationId = orderId.toString();
  for (const item of items) {
    await db.collection('inventory').updateOne(
      {
        productId: item.productId,
        variantSku: item.variant.sku,
        reservedOrderIds: reservationId,
      },
      {
        $pull: { reservedOrderIds: reservationId },
        ...(restoreStock ? { $inc: { stock: item.quantity } } : {}),
      },
    );
  }
}

async function loadProducts() {
  const sourceProducts = catalog.products.filter((product) => product.isActive);
  const productIds = sourceProducts.map((product) => product.id);
  const [settings, inventory] = await Promise.all([
    db.collection('productSettings').find({ productId: { $in: productIds } }).toArray(),
    db.collection('inventory').find({ productId: { $in: productIds } }).toArray(),
  ]);
  const settingsById = new Map(settings.map((item) => [item.productId, item]));
  const inventoryByVariant = new Map(
    inventory.map((item) => [`${item.productId}:${item.variantSku}`, item]),
  );

  return sourceProducts.map((product) => {
    const savedSettings = settingsById.get(product.id);
    const variants = product.variants.map((variant) => ({
      ...variant,
      stock: inventoryByVariant.get(`${product.id}:${variant.sku}`)?.stock ?? variant.stock,
    }));
    return {
      ...product,
      variants,
      totalStock: variants.reduce((total, variant) => total + variant.stock, 0),
      isActive: savedSettings?.isActive ?? product.isActive,
      isNewArrival: savedSettings?.isNewArrival ?? product.isNewArrival,
    };
  }).filter((product) => product.isActive);
}

app.get('/api/products', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({
      categories: catalog.categories,
      homepage: catalog.homepage,
      products: await loadProducts(),
    });
  } catch (error) {
    return next(error);
  }
});

// Register all admin APIs on this router so the Better Auth role check is applied by default.
const adminApi = express.Router();
adminApi.use(requireAdmin);

adminApi.get('/dashboard', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const orders = db.collection('orders');
    const [customers, orderCount, revenueRows, paidOrders, pendingOrders, products, recentOrders] = await Promise.all([
      db.collection('user').countDocuments({ role: { $ne: 'admin' } }),
      orders.countDocuments(),
      orders.aggregate([
        { $match: { paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$total', 0] } } } },
      ]).toArray(),
      orders.countDocuments({ paymentStatus: 'paid' }),
      orders.countDocuments({ status: 'pending_confirmation' }),
      loadProducts(),
      orders.find({}, {
        projection: {
          orderNumber: 1,
          customer: 1,
          total: 1,
          status: 1,
          paymentStatus: 1,
          createdAt: 1,
        },
      }).sort({ createdAt: -1 }).limit(6).toArray(),
    ]);

    return res.json({
      customers,
      orders: orderCount,
      products: products.length,
      outOfStockProducts: products.filter((product) => product.totalStock <= 0).length,
      revenue: revenueRows[0]?.total || 0,
      paidOrders,
      pendingOrders,
      recentOrders: recentOrders.map((order) => ({
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        customerName: order.customer?.name || 'Customer',
        total: order.total,
        status: order.status,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

adminApi.get('/customers', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = 50;
    const users = db.collection('user');
    const filter = { role: { $ne: 'admin' } };
    const [records, total] = await Promise.all([
      users.find(filter, {
        projection: {
          name: 1,
          email: 1,
          emailVerified: 1,
          image: 1,
          role: 1,
          banned: 1,
          banReason: 1,
          createdAt: 1,
        },
      }).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      users.countDocuments(filter),
    ]);
    const customerIds = records.map((user) => String(user._id));
    const orders = customerIds.length
      ? await db.collection('orders').find(
          { userId: { $in: customerIds } },
          {
            projection: {
              userId: 1,
              orderNumber: 1,
              items: 1,
              total: 1,
              status: 1,
              paymentStatus: 1,
              createdAt: 1,
            },
          },
        ).sort({ createdAt: -1 }).toArray()
      : [];
    const ordersByUser = new Map(customerIds.map((id) => [id, []]));
    for (const order of orders) {
      ordersByUser.get(order.userId)?.push({
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        items: order.items.map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
        })),
        total: order.total,
        status: order.status,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt,
      });
    }

    return res.json({
      page,
      total,
      hasMore: page * pageSize < total,
      customers: records.map((user) => {
        const id = String(user._id);
        const customerOrders = ordersByUser.get(id) || [];
        return {
          id,
          name: user.name,
          email: user.email,
          emailVerified: Boolean(user.emailVerified),
          image: user.image || null,
          role: user.role || 'user',
          banned: Boolean(user.banned),
          banReason: user.banReason || '',
          createdAt: user.createdAt,
          orderCount: customerOrders.length,
          totalSpent: customerOrders.reduce((sum, order) => sum + (order.total || 0), 0),
          orders: customerOrders,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/faq-queries', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    const website = typeof req.body?.website === 'string' ? req.body.website.trim() : '';

    // Silently accept bot submissions caught by the form's honeypot field.
    if (website) return res.status(201).json({ ok: true });
    if (!name || !email || !query) {
      return res.status(400).json({ error: 'Please enter your name, email, and question.' });
    }
    if (name.length > 100 || email.length > 254 || query.length > 5000) {
      return res.status(400).json({ error: 'Your name, email, or question is too long.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const user = req.headers.cookie ? await getAuthenticatedUser(req) : null;
    const result = await db.collection('faqQueries').insertOne({
      name,
      email,
      query,
      ...(typeof user?.email === 'string' && user.email.toLowerCase() === email
        ? { userId: user.id }
        : {}),
      status: 'new',
      createdAt: new Date(),
    });
    return res.status(201).json({ ok: true, id: result.insertedId.toString() });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/customer/faq-replies/unread-count', requireCustomer, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const user = req.authenticatedUser;
    const email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
    const filter = {
      reply: { $type: 'string', $ne: '' },
      readAt: { $exists: false },
      $or: [
        { userId: user.id },
        ...(email ? [{ userId: { $exists: false }, email }] : []),
      ],
    };
    const count = await db.collection('faqQueries').countDocuments(filter);
    return res.json({ count });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/customer/faq-replies', requireCustomer, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const user = req.authenticatedUser;
    const collection = db.collection('faqQueries');
    const email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
    const filter = {
      $or: [
        { userId: user.id },
        ...(email ? [{ userId: { $exists: false }, email }] : []),
      ],
    };
    const [queries] = await Promise.all([
      collection.find(filter, {
        projection: {
          name: 1,
          email: 1,
          query: 1,
          reply: 1,
          status: 1,
          createdAt: 1,
          repliedAt: 1,
        },
      }).sort({ createdAt: -1 }).limit(100).toArray(),
      collection.updateMany(
        { ...filter, reply: { $type: 'string', $ne: '' }, readAt: { $exists: false } },
        { $set: { readAt: new Date() } },
      ),
    ]);
    return res.json({
      queries: queries.map((item) => ({
        id: item._id.toString(),
        name: item.name,
        query: item.query,
        reply: item.reply || '',
        status: item.status,
        createdAt: item.createdAt,
        repliedAt: item.repliedAt || null,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

adminApi.patch('/faq-queries/:id/reply', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Choose a valid customer question.' });
    }
    const reply = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
    if (!reply || reply.length > 5000) {
      return res.status(400).json({ error: 'Enter a reply between 1 and 5,000 characters.' });
    }

    const result = await db.collection('faqQueries').findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          reply,
          repliedAt: new Date(),
          repliedBy: req.authenticatedUser.id,
          status: 'answered',
        },
        $unset: { readAt: '' },
      },
      { returnDocument: 'after' },
    );
    if (!result) return res.status(404).json({ error: 'Customer question not found.' });
    return res.json({
      query: {
        id: result._id.toString(),
        reply: result.reply,
        repliedAt: result.repliedAt,
        status: result.status,
      },
    });
  } catch (error) {
    return next(error);
  }
});

adminApi.get('/products', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ categories: catalog.categories, products: await loadProducts() });
  } catch (error) {
    return next(error);
  }
});

adminApi.patch('/products/:id', async (req, res, next) => {
  try {
    const product = productsById.get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const isNewArrival = req.body?.isNewArrival;
    const variants = req.body?.variants;
    if (
      typeof isNewArrival !== 'boolean'
      || !Array.isArray(variants)
      || variants.length !== product.variants.length
    ) {
      return res.status(400).json({ error: 'Provide a new-arrival setting and a quantity for every product variant.' });
    }

    const stocksBySku = new Map();
    for (const variant of variants) {
      if (
        typeof variant?.sku !== 'string'
        || !product.variants.some((item) => item.sku === variant.sku)
        || !Number.isInteger(variant.stock)
        || variant.stock < 0
        || variant.stock > 99999
        || stocksBySku.has(variant.sku)
      ) {
        return res.status(400).json({ error: 'Enter a valid non-negative quantity for every product variant.' });
      }
      stocksBySku.set(variant.sku, variant.stock);
    }
    if (stocksBySku.size !== product.variants.length) {
      return res.status(400).json({ error: 'Provide a quantity for every product variant.' });
    }

    const settings = db.collection('productSettings');
    const currentSettings = await settings.findOne({ productId: product.id });
    if (currentSettings?.isActive === false) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const now = new Date();
    await db.collection('inventory').bulkWrite(
      [...stocksBySku].map(([variantSku, stock]) => ({
        updateOne: {
          filter: { productId: product.id, variantSku },
          update: { $set: { stock, updatedAt: now } },
          upsert: true,
        },
      })),
      { ordered: true },
    );
    await settings.updateOne(
      { productId: product.id },
      {
        $set: { isNewArrival, isActive: true, updatedAt: now },
        $setOnInsert: { productId: product.id, createdAt: now },
      },
      { upsert: true },
    );
    const updatedProduct = (await loadProducts()).find((item) => item.id === product.id);
    return res.json({ product: updatedProduct });
  } catch (error) {
    return next(error);
  }
});

adminApi.delete('/products/:id', async (req, res, next) => {
  try {
    const product = productsById.get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const result = await db.collection('productSettings').updateOne(
      { productId: product.id },
      { $set: { isActive: false, updatedAt: new Date() } },
    );
    if (!result.matchedCount) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    await Promise.all([
      db.collection(collectionNames.cart).deleteMany({ productId: product.id }),
      db.collection(collectionNames.wishlist).deleteMany({ productId: product.id }),
    ]);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

adminApi.get('/faq-queries', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = 50;
    const collection = db.collection('faqQueries');
    const [queries, total] = await Promise.all([collection
      .find({}, { projection: { name: 1, email: 1, query: 1, reply: 1, status: 1, createdAt: 1, repliedAt: 1 } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(), collection.countDocuments()]);
    return res.json({ page, total, hasMore: page * pageSize < total, queries: queries.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      email: item.email,
      query: item.query,
      reply: item.reply || '',
      status: item.status,
      createdAt: item.createdAt,
      repliedAt: item.repliedAt || null,
    })) });
  } catch (error) {
    return next(error);
  }
});

adminApi.get('/orders', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const filter = {};
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const paymentStatus = typeof req.query.paymentStatus === 'string' ? req.query.paymentStatus : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : null;
    if (status && !orderStatuses.includes(status)) {
      return res.status(400).json({ error: 'Choose a valid order status.' });
    }
    if (paymentStatus && !['pending', 'paid'].includes(paymentStatus)) {
      return res.status(400).json({ error: 'Choose a valid payment status.' });
    }
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { orderNumber: { $regex: escaped, $options: 'i' } },
        { 'customer.name': { $regex: escaped, $options: 'i' } },
        { 'customer.email': { $regex: escaped, $options: 'i' } },
        { 'customer.phone': { $regex: escaped, $options: 'i' } },
      ];
    }
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      filter.createdAt = {};
      if (from && !Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
      if (to && !Number.isNaN(to.getTime())) {
        to.setUTCHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }
    const orders = await db.collection('orders').find(filter, { projection: { idempotencyKey: 0 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return res.json({ orders: orders.map(serializeOrder), statuses: orderStatuses });
  } catch (error) {
    return next(error);
  }
});

adminApi.patch('/orders/:id/status', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Choose a valid order.' });
    }
    res.set('Cache-Control', 'no-store');
    const status = typeof req.body?.status === 'string' ? req.body.status : '';
    if (!orderStatuses.includes(status)) {
      return res.status(400).json({ error: 'Choose a valid order status.' });
    }
    const orders = db.collection('orders');
    const objectId = new ObjectId(req.params.id);
    const current = await orders.findOne({ _id: objectId });
    if (!current) return res.status(404).json({ error: 'Order not found.' });
    if (current.status === status) {
      if (status === 'cancelled' || status === 'delivered') {
        await releaseOrderInventory(objectId, current.items, status === 'cancelled');
      }
      return res.json({ order: serializeOrder(current) });
    }
    const allowedTransitions = {
      pending_confirmation: ['confirmed', 'cancelled'],
      confirmed: ['processing', 'cancelled'],
      processing: ['shipped', 'cancelled'],
      shipped: ['delivered'],
      delivered: [],
      cancelled: [],
    };
    if (!allowedTransitions[current.status]?.includes(status)) {
      return res.status(409).json({ error: 'This order cannot move to the selected status.' });
    }
    const result = await orders.findOneAndUpdate(
      { _id: objectId, status: current.status },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      const latest = await orders.findOne({ _id: objectId });
      if (latest?.status === status) {
        if (status === 'cancelled' || status === 'delivered') {
          await releaseOrderInventory(objectId, latest.items, status === 'cancelled');
        }
        return res.json({ order: serializeOrder(latest) });
      }
      return res.status(409).json({ error: 'The order status changed. Refresh and try again.' });
    }
    if (status === 'cancelled' || status === 'delivered') {
      await releaseOrderInventory(objectId, result.items, status === 'cancelled');
    }
    return res.json({ order: serializeOrder(result) });
  } catch (error) {
    return next(error);
  }
});

adminApi.patch('/orders/:id/payment-status', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Choose a valid order.' });
    }
    res.set('Cache-Control', 'no-store');
    if (req.body?.paymentStatus !== 'paid') {
      return res.status(400).json({ error: 'Payment can only be marked as paid after collection is verified.' });
    }
    const orders = db.collection('orders');
    const _id = new ObjectId(req.params.id);
    const current = await orders.findOne({ _id });
    if (!current) return res.status(404).json({ error: 'Order not found.' });
    if (current.paymentMethod !== 'COD') {
      return res.status(409).json({ error: 'This payment method cannot be marked as collected here.' });
    }
    if (current.paymentStatus === 'paid') {
      return res.json({ order: serializeOrder(current) });
    }
    if (current.paymentStatus !== 'pending') {
      return res.status(409).json({ error: 'This payment is not in a payable state.' });
    }
    const result = await orders.findOneAndUpdate(
      { _id, paymentMethod: 'COD', paymentStatus: 'pending' },
      { $set: { paymentStatus: 'paid', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!result) {
      const latest = await orders.findOne({ _id });
      if (!latest) return res.status(404).json({ error: 'Order not found.' });
      if (latest.paymentMethod === 'COD' && latest.paymentStatus === 'paid') {
        return res.json({ order: serializeOrder(latest) });
      }
      return res.status(409).json({ error: 'The payment status changed. Refresh and try again.' });
    }
    return res.json({ order: serializeOrder(result) });
  } catch (error) {
    return next(error);
  }
});

app.use('/api/admin', adminApi);

app.post('/api/orders', requireCustomer, async (req, res, next) => {
  const reservedItems = [];
  let orderId;
  let orderSaved = false;
  try {
    const user = req.authenticatedUser;
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey.trim()
      : '';
    const address = req.body?.address;
    if (!/^[\w-]{16,80}$/.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Please refresh checkout and try again.' });
    }
    if (!address || typeof address !== 'object' || Array.isArray(address)) {
      return res.status(400).json({ error: 'Enter your delivery details.' });
    }
    const deliveryAddress = {
      name: typeof address.name === 'string' ? address.name.trim() : '',
      phone: typeof address.phone === 'string' ? address.phone.trim() : '',
      addressLine: typeof address.addressLine === 'string' ? address.addressLine.trim() : '',
      city: typeof address.city === 'string' ? address.city.trim() : '',
      postalCode: typeof address.postalCode === 'string' ? address.postalCode.trim() : '',
    };
    const normalizedPhone = deliveryAddress.phone.replace(/[\s()-]/g, '');
    const fieldErrors = {};
    if (deliveryAddress.name.length < 2 || deliveryAddress.name.length > 100) {
      fieldErrors.name = 'Enter a name between 2 and 100 characters.';
    }
    if (
      deliveryAddress.phone.length > 30
      || !/^(?:\+?8801[3-9]\d{8}|01[3-9]\d{8})$/.test(normalizedPhone)
    ) {
      fieldErrors.phone = 'Enter a valid Bangladesh mobile number, such as 01XXXXXXXXX or +8801XXXXXXXXX.';
    }
    if (deliveryAddress.addressLine.length < 5 || deliveryAddress.addressLine.length > 250) {
      fieldErrors.addressLine = 'Enter a complete house/road and area (5–250 characters).';
    }
    if (deliveryAddress.city.length < 2 || deliveryAddress.city.length > 100) {
      fieldErrors.city = 'Enter a city or area between 2 and 100 characters.';
    }
    if (deliveryAddress.postalCode.length > 20) {
      fieldErrors.postalCode = 'Postal code must be 20 characters or fewer.';
    }
    if (Object.keys(fieldErrors).length) {
      return res.status(400).json({ error: 'Check the delivery details and try again.', fieldErrors });
    }

    const orders = db.collection('orders');
    const existingOrder = await orders.findOne({ userId: user.id, idempotencyKey });
    if (existingOrder) {
      await clearPurchasedCartItems(user.id, existingOrder.items);
      return res.status(200).json({ order: serializeOrder(existingOrder), existing: true });
    }

    const lines = await db.collection(collectionNames.cart).find({ userId: user.id }).limit(51).toArray();
    if (!lines.length || lines.length > 50) {
      return res.status(400).json({ error: 'Your cart must contain between 1 and 50 products.' });
    }
    const seenLines = new Set();
    const orderItems = [];
    for (const line of lines) {
      const productId = typeof line.productId === 'string' ? line.productId.trim() : '';
      const variantSku = typeof line.variantSku === 'string' ? line.variantSku.trim() : '';
      const quantity = line.quantity;
      const key = `${productId}:${variantSku}`;
      if (!productId || !variantSku || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || seenLines.has(key)) {
        return res.status(400).json({ error: 'Your cart contains an invalid product or quantity. Review it and try again.' });
      }
      seenLines.add(key);
      const product = productsById.get(productId);
      const variant = product?.variants?.find((item) => item.sku === variantSku);
      const settings = product
        ? await db.collection('productSettings').findOne({ productId })
        : null;
      const stock = product && variant
        ? await db.collection('inventory').findOne({ productId, variantSku })
        : null;
      if (!product || settings?.isActive === false || !variant || !stock || stock.stock < quantity) {
        return res.status(409).json({ error: `${product?.name || 'A product'} is unavailable in the selected quantity.` });
      }
      const image = product.images.find((item) => item.isPrimary)?.url || product.images[0]?.url || '';
      const unitPrice = Number.isFinite(variant.price) ? variant.price : product.price;
      orderItems.push({
        productId,
        productName: product.name,
        image,
        variant: { sku: variant.sku, label: variant.label },
        attributes: product.attributes || {},
        quantity,
        unitPrice,
        subtotal: unitPrice * quantity,
      });
    }

    const subtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const createdAt = new Date();
    const estimatedDeliveryDate = addCalendarDays(createdAt, 2);
    orderId = new ObjectId();
    const order = {
      _id: orderId,
      orderNumber: `LEE-${createdAt.toISOString().slice(2, 10).replace(/-/g, '')}-${orderId.toString().toUpperCase()}`,
      userId: user.id,
      customer: {
        name: deliveryAddress.name,
        email: typeof user.email === 'string' ? user.email : '',
        phone: deliveryAddress.phone,
      },
      items: orderItems,
      subtotal,
      deliveryFee,
      total: subtotal + deliveryFee,
      address: deliveryAddress,
      createdAt,
      updatedAt: createdAt,
      estimatedDeliveryDate,
      paymentMethod: 'COD',
      paymentStatus: 'pending',
      status: 'pending_confirmation',
      idempotencyKey,
    };

    for (const item of orderItems) {
      const reservation = await db.collection('inventory').updateOne(
        {
          productId: item.productId,
          variantSku: item.variant.sku,
          stock: { $gte: item.quantity },
        },
        {
          $inc: { stock: -item.quantity },
          $addToSet: { reservedOrderIds: orderId.toString() },
          $set: { updatedAt: createdAt },
        },
      );
      if (!reservation.matchedCount) {
        await releaseOrderInventory(orderId, reservedItems, true);
        reservedItems.length = 0;
        return res.status(409).json({ error: `${item.productName} is no longer available in the selected quantity.` });
      }
      reservedItems.push(item);
    }

    try {
      await orders.insertOne(order);
      orderSaved = true;
    } catch (error) {
      if (error.code === 11000) {
        const duplicate = await orders.findOne({ userId: user.id, idempotencyKey });
        if (duplicate) {
          await releaseOrderInventory(orderId, reservedItems, true);
          reservedItems.length = 0;
          await clearPurchasedCartItems(user.id, duplicate.items);
          return res.status(200).json({ order: serializeOrder(duplicate), existing: true });
        }
      }
      throw error;
    }
    await clearPurchasedCartItems(user.id, orderItems);
    return res.status(201).json({ order: serializeOrder(order), existing: false });
  } catch (error) {
    if (!orderSaved && orderId && reservedItems.length) {
      try {
        await releaseOrderInventory(orderId, reservedItems, true);
      } catch (rollbackError) {
        console.error('Could not restore reserved order inventory:', rollbackError);
      }
    }
    return next(error);
  }
});

app.get('/api/orders/my-orders', requireCustomer, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const orders = await db.collection('orders').find(
      { userId: req.authenticatedUser.id },
      { projection: { idempotencyKey: 0 } },
    ).sort({ createdAt: -1 }).limit(100).toArray();
    return res.json({ orders: orders.map(serializeOrder) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/orders/:id', requireCustomer, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Choose a valid order.' });
    }
    const order = await db.collection('orders').findOne({ _id: new ObjectId(req.params.id) });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.userId !== req.authenticatedUser.id && req.authenticatedUser.role !== 'admin') {
      return res.status(403).json({ error: 'You cannot view this order.' });
    }
    delete order.idempotencyKey;
    return res.json({ order: serializeOrder(order) });
  } catch (error) {
    return next(error);
  }
});

async function resolveAccount(req, res, next) {
  const collectionName = collectionNames[req.params.resource];
  if (!collectionName) return res.status(404).json({ error: 'Not found.' });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });

    if (!initializedIndexes.has(collectionName)) {
      if (req.params.resource === 'cart') {
        const indexes = await db.collection(collectionName).indexes().catch(() => []);
        if (indexes.some((index) => index.name === 'userId_1_productId_1')) {
          await db.collection(collectionName).dropIndex('userId_1_productId_1');
        }
        const legacyItems = await db.collection(collectionName).find({ variantSku: { $exists: false } }).toArray();
        for (const item of legacyItems) {
          const product = productsById.get(item.productId);
          if (product?.variants[0]?.sku) {
            await db.collection(collectionName).updateOne(
              { _id: item._id },
              { $set: { variantSku: product.variants[0].sku } },
            );
          }
        }
        await db.collection(collectionName).createIndex(
          { userId: 1, productId: 1, variantSku: 1 },
          { unique: true },
        );
      } else {
        await db.collection(collectionName).createIndex(
          { userId: 1, productId: 1 },
          { unique: true },
        );
      }
      initializedIndexes.add(collectionName);
    }

    req.account = {
      userId: user.id,
      resource: req.params.resource,
      collection: db.collection(collectionName),
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

app.get('/api/account/:resource', resolveAccount, async (req, res, next) => {
  try {
    const { collection, userId, resource } = req.account;
    const savedItems = await collection.find({ userId }).sort({ updatedAt: -1 }).toArray();
    const activeProducts = new Map((await loadProducts()).map((product) => [product.id, product]));
    const items = savedItems.flatMap((saved) => {
      const product = activeProducts.get(saved.productId);
      if (!product) return [];
      const selectedVariant = resource === 'cart'
        ? product.variants.find((variant) => variant.sku === saved.variantSku) || product.variants[0]
        : undefined;
      const itemPrice = resource === 'cart' && Number.isFinite(selectedVariant?.price)
        ? selectedVariant.price
        : product.price;
      return [{
        ...product,
        ...(resource === 'cart' ? { price: itemPrice } : {}),
        ...(resource === 'cart' ? {
          quantity: Math.max(1, saved.quantity || 1),
          selectedVariant,
          cartItemId: `${product.id}:${selectedVariant?.sku || 'default'}`,
        } : {}),
      }];
    });
    if (resource === 'cart') {
      const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      return res.json({ items, subtotal, deliveryFee, total: subtotal + deliveryFee });
    }
    return res.json({ items });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/account/:resource', resolveAccount, async (req, res, next) => {
  try {
    const productId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
    if (!productsById.has(productId)) {
      return res.status(400).json({ error: 'Choose a valid product.' });
    }

    const { collection, userId, resource } = req.account;
    const variantSku = typeof req.body?.variantSku === 'string' ? req.body.variantSku.trim() : '';
    const product = productsById.get(productId);
    const settings = product
      ? await db.collection('productSettings').findOne({ productId })
      : null;
    if (!product || settings?.isActive === false) {
      return res.status(400).json({ error: 'Choose a valid product.' });
    }
    const selectedVariant = resource === 'cart'
      ? product.variants.find((variant) => variant.sku === variantSku) || (product.variants.length === 1 ? product.variants[0] : null)
      : null;
    if (resource === 'cart' && !selectedVariant) {
      return res.status(400).json({ error: 'Choose an available size.' });
    }
    if (resource === 'cart') {
      const inventory = await db.collection('inventory').findOne({
        productId,
        variantSku: selectedVariant.sku,
      });
      if (!inventory || inventory.stock < 1) {
        return res.status(409).json({ error: 'This product is currently out of stock.' });
      }
    }
    if (resource === 'wishlist') {
      const alreadyInCart = await db.collection(collectionNames.cart).findOne({ userId, productId });
      if (alreadyInCart) {
        return res.status(409).json({
          error: 'This product is already in your cart and cannot be added to your wishlist.',
        });
      }
    }

    const now = new Date();
    const result = await collection.updateOne(
      resource === 'cart' ? { userId, productId, variantSku: selectedVariant.sku } : { userId, productId },
      {
        $setOnInsert: {
          userId,
          productId,
          createdAt: now,
          ...(resource === 'cart' ? { quantity: 1 } : {}),
          ...(resource === 'cart' ? { variantSku: selectedVariant.sku } : {}),
        },
        $set: { updatedAt: now },
      },
      { upsert: true },
    );
    return res.json({ ok: true, inserted: result.upsertedCount === 1 });
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/account/:resource', resolveAccount, async (req, res, next) => {
  try {
    const { collection, userId, resource } = req.account;
    if (resource !== 'cart') {
      return res.status(405).json({ error: 'This collection cannot be updated.' });
    }
    const productId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
    const variantSku = typeof req.body?.variantSku === 'string' ? req.body.variantSku.trim() : '';
    const quantity = Number(req.body?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 99.' });
    }

    const result = await collection.updateOne(
      { userId, productId, ...(variantSku ? { variantSku } : {}) },
      { $set: { quantity, updatedAt: new Date() } },
    );
    if (!result.matchedCount) {
      return res.status(404).json({ error: 'This product is not in your cart.' });
    }
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.delete('/api/account/:resource', resolveAccount, async (req, res, next) => {
  try {
    const productId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
    const variantSku = typeof req.body?.variantSku === 'string' ? req.body.variantSku.trim() : '';
    if (!productId) return res.status(400).json({ error: 'Choose a valid product.' });
    await req.account.collection.deleteOne({
      userId: req.account.userId,
      productId,
      ...(variantSku ? { variantSku } : {}),
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

app.get('/', (req, res) => res.send('Leebazz Server is running.'));

app.use((error, req, res, next) => {
  console.error('API request failed:', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Could not complete your request.' });
});





async function run() {
  await client.connect();
  db = client.db('leebazz');
  await db.collection('faqQueries').createIndex({ createdAt: -1 });
  const orders = db.collection('orders');
  const idempotencyIndexName = 'orders_user_idempotency_unique';
  const idempotencyIndexKey = { userId: 1, idempotencyKey: 1 };
  const idempotencyPartialFilter = { idempotencyKey: { $type: 'string' } };
  const knownIndexFields = new Set([
    'v',
    'key',
    'name',
    'ns',
    'unique',
    'background',
    'partialFilterExpression',
  ]);
  const existingIdempotencyIndex = (await orders.listIndexes().toArray())
    .find((index) => index.name === idempotencyIndexName);
  if (existingIdempotencyIndex) {
    const hasExpectedKey = Object.keys(existingIdempotencyIndex.key).length === 2
      && existingIdempotencyIndex.key.userId === 1
      && existingIdempotencyIndex.key.idempotencyKey === 1;
    const hasOnlyKnownFields = Object.keys(existingIdempotencyIndex)
      .every((field) => knownIndexFields.has(field));
    const isLegacyIndex = hasExpectedKey
      && existingIdempotencyIndex.unique === true
      && !existingIdempotencyIndex.partialFilterExpression
      && hasOnlyKnownFields;
    const isCurrentIndex = hasExpectedKey
      && existingIdempotencyIndex.unique === true
      && JSON.stringify(existingIdempotencyIndex.partialFilterExpression) === JSON.stringify(idempotencyPartialFilter)
      && hasOnlyKnownFields;
    if (isLegacyIndex) {
      await orders.dropIndex(idempotencyIndexName);
    } else if (!isCurrentIndex) {
      throw new Error(`Cannot safely replace ${idempotencyIndexName}: its definition differs from the expected unique index.`);
    }
  }
  await orders.createIndex(idempotencyIndexKey, {
    unique: true,
    name: idempotencyIndexName,
    partialFilterExpression: idempotencyPartialFilter,
  });
  await orders.createIndex({ userId: 1, createdAt: -1 });
  await orders.createIndex({ status: 1, createdAt: -1 });
  const inventory = db.collection('inventory');
  await inventory.createIndex(
    { productId: 1, variantSku: 1 },
    { unique: true, name: 'inventory_product_variant_unique' },
  );
  const inventoryUpdates = catalog.products
    .filter((product) => product.isActive)
    .flatMap((product) => product.variants.map((variant) => ({
      updateOne: {
        filter: { productId: product.id, variantSku: variant.sku },
        update: {
          $setOnInsert: {
            productId: product.id,
            variantSku: variant.sku,
            stock: variant.stock,
            reservedOrderIds: [],
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    })));
  if (inventoryUpdates.length) await inventory.bulkWrite(inventoryUpdates, { ordered: false });
  const productSettingsUpdates = catalog.products
    .filter((product) => product.isActive)
    .map((product) => ({
      updateOne: {
        filter: { productId: product.id },
        update: {
          $setOnInsert: {
            productId: product.id,
            isActive: product.isActive,
            isNewArrival: product.isNewArrival,
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    }));
  if (productSettingsUpdates.length) {
    await db.collection('productSettings').bulkWrite(productSettingsUpdates, { ordered: false });
  }

  // Start Express Server
  app.listen(port, () => {
    console.log(`Leebazz Server running on port ${port}`);
  });
}

run().catch(async (error) => {
  console.error('Leebazz server startup failed:', error);
  try {
    await client.close();
  } catch (closeError) {
    console.error('Could not close MongoDB after startup failure:', closeError);
  }
  process.exitCode = 1;
});
