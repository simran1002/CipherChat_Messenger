import { Router } from "express";
import auth from "../middlewares/auth.js";
import { metrics } from "../shared/index.js";

const router = Router();

// GET /analytics/metrics — real-time delivery + latency stats
router.get("/metrics", auth, (_req, res) => {
  res.json(metrics.summary());
});

export default router;
