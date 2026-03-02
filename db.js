const { MongoClient } = require("mongodb");

let mongoClient;

async function connectDB() {
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGO_DB_NAME || "zodiac_guard";

  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();

  return mongoClient.db(dbName);
}

function getDB() {
  if (!mongoClient) {
    throw new Error("Database not connected. Call connectDB first.");
  }
  return mongoClient.db(process.env.MONGO_DB_NAME || "zodiac_guard");
}

async function closeDB() {
  if (mongoClient) {
    await mongoClient.close();
  }
}

module.exports = { connectDB, getDB, closeDB };
