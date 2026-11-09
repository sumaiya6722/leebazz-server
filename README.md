# Leebazz Server

The Leebazz server is the Express API for the Leebazz storefront. It serves the public catalog and provides authenticated customer and administrator operations backed by MongoDB.

## Live application

- Storefront: [https://leebazz-client.vercel.app](https://leebazz-client.vercel.app)
- API: [https://leebazz-server.vercel.app](https://leebazz-server.vercel.app)
- Health check: [https://leebazz-server.vercel.app/](https://leebazz-server.vercel.app/)
- Public catalog: [https://leebazz-server.vercel.app/api/products](https://leebazz-server.vercel.app/api/products)

## Features

- Public catalog endpoint with categories, homepage content, and active products
- MongoDB-backed cart and wishlist collections
- Inventory and product settings, including stock and availability
- Customer order creation, order history, order details, and FAQ replies
- Contact FAQ inquiry submission
- Admin dashboard, customer and order management, product updates, and FAQ responses
- Startup initialization for MongoDB indexes and product inventory/settings

## Authentication and security

Better Auth runs in the Next.js client application; this API does not create a separate JWT authentication system. The client proxies API requests through `/api/backend` and forwards the Better Auth HTTP-only session cookie. The API resolves that session using `BETTER_AUTH_URL`; customer and administrator routes derive the user identity and role from the validated session, not from client-supplied user IDs.

CORS is credentialed and restricted to the configured `CLIENT_URL`. Keep this set to the exact storefront origin in each environment. Do not use wildcard origins or disable session/role checks.

## Technology

- Node.js and Express 5
- MongoDB Node.js driver
- `dotenv` for local environment configuration
- `cors` for restricted cross-origin API access

The application is plain JavaScript (`index.js`) and does not use a separate compile step.

## Local development

Requirements: a current Node.js LTS release, npm, and a MongoDB database.

```bash
cd leebazz-server
npm install
node index.js
```

The API listens on port `5000` by default. Check [http://localhost:5000/](http://localhost:5000/) for the health response. The frontend is a separate application; start it from `leebazz-client` and configure it to use `http://localhost:5000`.

## Environment variables

Create an ignored `.env` file for local development and configure the variables in the deployment environment. Never commit credentials.

```env
MONGO_URL=
PORT=5000
CLIENT_URL=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000
DELIVERY_FEE_BDT=80
```

- `MONGO_URL` is required and must point to the MongoDB database.
- `PORT` is optional; the server defaults to `5000`.
- `CLIENT_URL` is the exact frontend origin allowed by CORS.
- `BETTER_AUTH_URL` is the frontend origin hosting the Better Auth session endpoint used to verify forwarded cookies.
- `DELIVERY_FEE_BDT` is optional; the API defaults to `80` when it is not a valid non-negative integer.

For production, set both `CLIENT_URL` and `BETTER_AUTH_URL` to `https://leebazz-client.vercel.app`. Set the storefront's `NEXT_PUBLIC_API_URL` to `https://leebazz-server.vercel.app`.

## API overview

| Endpoint | Purpose | Access |
|---|---|---|
| `GET /` | Health response | Public |
| `GET /api/products` | Categories, homepage content, and active catalog | Public |
| `POST /api/faq-queries` | Submit a customer inquiry | Public |
| `GET /api/customer/faq-replies` | Read the signed-in customer's replies | Customer session |
| `GET /api/customer/faq-replies/unread-count` | Read the customer's unread reply count | Customer session |
| `GET /api/account/:resource` | Read cart or wishlist | Customer session |
| `POST /api/account/:resource` | Add to cart or wishlist | Customer session |
| `PATCH /api/account/:resource` | Update cart item quantity | Customer session |
| `DELETE /api/account/:resource` | Remove a cart or wishlist item | Customer session |
| `POST /api/orders` | Create an order | Customer session |
| `GET /api/orders/my-orders` | Read the signed-in customer's order history | Customer session |
| `GET /api/orders/:id` | Read an order belonging to the signed-in customer | Customer session |
| `/api/admin/*` | Dashboard, customers, products, orders, and FAQ management | Admin session |

Protected account resources are `cart` and `wishlist`. Order and admin endpoints validate the session before accessing customer or management data.

## Project structure

```text
index.js                              Express app, middleware, and API routes
data/leebazz-import-ready-catalog-final.json
                                      Catalog source used by the API
package.json                          Runtime dependencies
```

## Deployment

The API is deployed at [https://leebazz-server.vercel.app](https://leebazz-server.vercel.app). Configure `MONGO_URL`, `CLIENT_URL`, and `BETTER_AUTH_URL` in the hosting environment; set `PORT` or `DELIVERY_FEE_BDT` only when needed. Use the exact storefront origin for both frontend URL settings. Configure the client app's `NEXT_PUBLIC_API_URL` to the API origin.

The frontend is deployed at [https://leebazz-client.vercel.app](https://leebazz-client.vercel.app). Confirm that the health check and public catalog endpoints respond after deployment. Never put secrets in frontend `NEXT_PUBLIC_` variables or commit `.env` files.
