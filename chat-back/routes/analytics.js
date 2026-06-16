const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const metrics = require("../shared/MetricsCollector");

// GET /analytics/metrics — real-time delivery + latency stats
router.get("/metrics", auth, (req, res) => {
  res.json(metrics.summary());
});

module.exports = router;
