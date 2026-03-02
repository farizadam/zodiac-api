const { MongoClient } = require("mongodb");

// Global cached connection (persists across warm invocations)
let mongoClient = null;
let cachedDb = null;

async function connectDB() {
  // Return cached connection if already connected
  if (cachedDb && mongoClient) {
    return cachedDb;
  }

  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGO_DB_NAME || "zodiac_guard";

  // Create new client only if needed
  if (!mongoClient) {
    mongoClient = new MongoClient(mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await mongoClient.connect();
  }

  cachedDb = mongoClient.db(dbName);
  return cachedDb;
}

function getDB() {
  if (!cachedDb) {
    throw new Error("Database not connected. Call connectDB first.");
  }
  return cachedDb;
}

async function closeDB() {
  if (mongoClient) {
    await mongoClient.close();
  }
}

module.exports = { connectDB, getDB, closeDB };
