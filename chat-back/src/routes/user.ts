import { Router } from "express";
import { catchErrors } from "../middlewares/errorHandlers.js";
import * as userController from "../controllers/userController.js";
import * as twoFactorController from "../controllers/twoFactorController.js";
import auth from "../middlewares/auth.js";
import upload from "../middlewares/upload.js";

const router = Router();

router.post("/login", catchErrors(userController.login));
router.post("/login/2fa", catchErrors(twoFactorController.completeLogin));
router.post("/register", catchErrors(userController.register));
// Two-factor management (all require a full session)
router.post("/2fa/setup", auth, catchErrors(twoFactorController.setup));
router.post("/2fa/enable", auth, catchErrors(twoFactorController.enable));
router.post("/2fa/disable", auth, catchErrors(twoFactorController.disable));
router.post("/refresh", catchErrors(userController.refresh));
router.post("/logout", catchErrors(userController.logout));
// Session management — each refresh-token row is one signed-in device/browser
router.get("/sessions", auth, catchErrors(userController.getSessions));
router.delete("/sessions", auth, catchErrors(userController.revokeOthers));
router.delete("/sessions/:sessionId", auth, catchErrors(userController.revokeSession));
router.get("/profile", auth, catchErrors(userController.getProfile));
router.put("/profile", auth, upload.single("dp"), catchErrors(userController.updateProfile));

export default router;
