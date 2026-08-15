import { Router } from "express";
import auth from "../middlewares/auth.js";
import { catchErrors } from "../middlewares/errorHandlers.js";
import { HttpError } from "../errors/HttpError.js";
import { PRESENCE_STATUSES, User, type PresenceStatus } from "../models/User.js";

const router = Router();

// PUT /presence — update current user's presence status
router.put(
  "/",
  auth,
  catchErrors(async (req, res) => {
    const { presenceStatus, presenceNote } = req.body as {
      presenceStatus?: string;
      presenceNote?: string;
    };
    if (presenceStatus && !PRESENCE_STATUSES.includes(presenceStatus as PresenceStatus))
      throw HttpError.badRequest("Invalid presence status.");

    const update: Record<string, string> = {};
    if (presenceStatus) update.presenceStatus = presenceStatus;
    if (presenceNote !== undefined) update.presenceNote = presenceNote.slice(0, 80);

    const user = await User.findByIdAndUpdate(req.payload!.id, update, { new: true }).select(
      "name presenceStatus presenceNote"
    );
    if (!user) throw HttpError.notFound("User not found.");
    res.json({ presenceStatus: user.presenceStatus, presenceNote: user.presenceNote });
  })
);

export default router;
