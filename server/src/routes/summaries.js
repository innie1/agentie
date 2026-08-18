import express from "express";
import { summarizeResponse } from "../lib/summaryService.js";

const router = express.Router();
router.post("/", async (req, res) => {
  const source = String(req.body?.text || "").trim();
  if (source.length < 80) return res.status(400).json({ error: "The response is already short." });
  if (source.length > 20000) return res.status(413).json({ error: "The response is too long to summarize at once." });
  try {
    res.json(await summarizeResponse(source));
  } catch (err) { res.status(502).json({ error: "Summary generation failed", detail: err.message }); }
});

export default router;
