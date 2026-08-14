import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = createApp();
const staticPath = process.env.NODE_ENV === "production" ? path.resolve(__dirname, "public") : path.resolve(__dirname, "..", "dist", "public");

app.use(express.static(staticPath));
app.get("*", (_request, response) => {
  response.sendFile(path.join(staticPath, "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`eFootball Leagues server running on http://localhost:${port}/`);
});
