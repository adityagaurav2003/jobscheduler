import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: "./drizzle",
  dialect: "postgresql",
  schema: "./db/schema.js",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});