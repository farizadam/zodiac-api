const { MongoClient } = require("mongodb");
require("dotenv").config();

async function seed() {
  const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017";
  const dbName = process.env.MONGO_DB_NAME || "zodiac_guard";

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db(dbName);
    const developers = db.collection("developers");
    const userRiskProfiles = db.collection("userRiskProfiles");

    // Clear existing data
    await developers.deleteMany({});
    await userRiskProfiles.deleteMany({});
    console.log("Cleared existing developers and userRiskProfiles");

    // Create indexes for fast lookups
    await userRiskProfiles.createIndex({ developerId: 1, senderId: 1 });
    console.log("✓ Created index on userRiskProfiles (developerId, senderId)");

    // Sample developers
    const seedData = [
      {
        apiKey: "sk_test_zodiac_123",
        name: "Test Dev 1",
        email: "dev1@example.com",
        credits: 100,
        usage: { usedThisMonth: 0, limit: 1000 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        apiKey: "sk_test_zodiac_456",
        name: "Test Dev 2",
        email: "dev2@example.com",
        credits: 50,
        usage: { usedThisMonth: 0, limit: 1000 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        apiKey: "sk_test_zodiac_789",
        name: "Test Dev 3",
        email: "dev3@example.com",
        credits: 25,
        usage: { usedThisMonth: 0, limit: 1000 },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // Insert seed data
    const result = await developers.insertMany(seedData);
    console.log(`✓ Inserted ${result.insertedIds.length} test developers\n`);

    // Display inserted data
    const all = await developers.find({}).toArray();
    console.log("📋 Seeded Developers:");
    all.forEach((dev) => {
      console.log(
        `  API Key: ${dev.apiKey} | Name: ${dev.name} | Credits: ${dev.credits}`,
      );
    });

    console.log("\n📊 userRiskProfiles collection ready (empty for now)");
    console.log(
      "   Schema: { developerId, senderId, riskScore, violationCount, lastViolationAt }",
    );
    console.log("   Profiles auto-create on first unsafe message per user.");
  } catch (error) {
    console.error("Seeding failed:", error);
  } finally {
    await client.close();
    console.log("\nDatabase connection closed");
  }
}

seed();
