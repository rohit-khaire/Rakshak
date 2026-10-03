const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/rakshak';
    const conn = await mongoose.connect(uri);
    console.log(`[Rakshak] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    await healLegacyIndexes(conn);
  } catch (err) {
    console.error(`[Rakshak] MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

// Defensive cleanup: if this database was previously used with a
// different schema (e.g. an earlier ChatGPT-generated version with a
// unique `caseNumber` field), a leftover unique index can silently
// break every case creation after the first one, since our current
// schema never sets that field (every doc gets caseNumber: null, and
// a unique index only allows ONE null). This runs on every boot and
// removes any index our current schema doesn't define, so a stale
// index can't block the app without anyone having to hunt for it
// manually.
const KNOWN_GOOD_INDEXES = {
  cases: ['_id_', 'lastSeenLocation.geo_2dsphere', 'status_1', 'jurisdiction.state_1_jurisdiction.district_1'],
  sightings: ['_id_', 'location.geo_2dsphere', 'caseId_1_status_1'],
  users: ['_id_', 'email_1'],
  policestations: ['_id_', 'geo_2dsphere'],
};

const healLegacyIndexes = async (conn) => {
  const collections = await conn.connection.db.listCollections().toArray();
  const collectionNames = new Set(collections.map((c) => c.name));

  for (const [collName, keep] of Object.entries(KNOWN_GOOD_INDEXES)) {
    if (!collectionNames.has(collName)) continue;
    try {
      const indexes = await conn.connection.db.collection(collName).indexes();
      for (const idx of indexes) {
        if (!keep.includes(idx.name)) {
          await conn.connection.db.collection(collName).dropIndex(idx.name);
          console.warn(`[Rakshak] Dropped stale index "${idx.name}" on "${collName}" (left over from a different schema version).`);
        }
      }
    } catch (err) {
      console.warn(`[Rakshak] Could not inspect/clean indexes on "${collName}": ${err.message}`);
    }
  }
};

module.exports = connectDB;
