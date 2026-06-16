const router = require("express").Router();
const auth = require("../middlewares/auth");
const { catchErrors } = require("../handlers/errorHandlers");
const mongoose = require("mongoose");
const User = mongoose.model("User");

const VALID_STATUSES = ["available", "coding", "in_meeting", "focusing", "driving", "away", "busy"];

// PUT /presence — update current user's presence status
router.put("/", auth, catchErrors(async (req, res) => {
  const { presenceStatus, presenceNote } = req.body;
  if (presenceStatus && !VALID_STATUSES.includes(presenceStatus)) throw "Invalid presence status.";

  const update = {};
  if (presenceStatus) update.presenceStatus = presenceStatus;
  if (presenceNote !== undefined) update.presenceNote = presenceNote.slice(0, 80);

  const user = await User.findByIdAndUpdate(req.payload.id, update, { new: true }).select("name presenceStatus presenceNote");
  res.json({ presenceStatus: user.presenceStatus, presenceNote: user.presenceNote });
}));

module.exports = router;
