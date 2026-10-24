const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('node:path');
const { MongoClient, ServerApiVersion } = require('mongodb');


const app = express();
const port = Number(process.env.PORT) || 5000;
const authUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3000';

const catalog = require(path.join(__dirname, '../leebazz-client/public/leebazz-expanded-catalog.json'));

const productsById = new Map(
  catalog.products.filter((product) => product.isActive).map((product) => [product.id, product]),
);

const collectionNames = { cart: 'carts', wishlist: 'wishlists' };

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

// Register all admin APIs on this router so the Better Auth role check is applied by default.
const adminApi = express.Router();
adminApi.use(requireAdmin);

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

    const result = await db.collection('faqQueries').insertOne({
      name,
      email,
      query,
      status: 'new',
      createdAt: new Date(),
    });
    return res.status(201).json({ ok: true, id: result.insertedId.toString() });
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
      .find({}, { projection: { name: 1, email: 1, query: 1, status: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(), collection.countDocuments()]);
    return res.json({ page, total, hasMore: page * pageSize < total, queries: queries.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      email: item.email,
      query: item.query,
      status: item.status,
      createdAt: item.createdAt,
    })) });
  } catch (error) {
    return next(error);
  }
});

app.use('/api/admin', adminApi);

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
    const items = savedItems.flatMap((saved) => {
      const product = productsById.get(saved.productId);
      if (!product) return [];
      const selectedVariant = resource === 'cart'
        ? product.variants.find((variant) => variant.sku === saved.variantSku) || product.variants[0]
        : undefined;
      return [{
        ...product,
        ...(resource === 'cart' ? {
          quantity: Math.max(1, saved.quantity || 1),
          selectedVariant,
          cartItemId: `${product.id}:${selectedVariant?.sku || 'default'}`,
        } : {}),
      }];
    });
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
    const selectedVariant = resource === 'cart'
      ? product.variants.find((variant) => variant.sku === variantSku) || (product.variants.length === 1 ? product.variants[0] : null)
      : null;
    if (resource === 'cart' && !selectedVariant) {
      return res.status(400).json({ error: 'Choose an available size.' });
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
  try {
    await client.connect();
    db = client.db('leebazz');
    await db.collection('faqQueries').createIndex({ createdAt: -1 });

    // Start Express Server
    app.listen(port, () => {
      console.log(`Leebazz Server running on port ${port}`);
    });

  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  }
}

run().catch(console.dir);
