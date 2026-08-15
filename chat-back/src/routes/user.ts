import { Router } from "express";
import { catchErrors } from "../middlewares/errorHandlers.js";
import * as userController from "../controllers/userController.js";
import auth from "../middlewares/auth.js";
import upload from "../middlewares/upload.js";

const router = Router();

router.post("/login", catchErrors(userController.login));
router.post("/register", catchErrors(userController.register));
router.post("/refresh", catchErrors(userController.refresh));
router.post("/logout", catchErrors(userController.logout));
router.get("/profile", auth, catchErrors(userController.getProfile));
router.put("/profile", auth, upload.single("dp"), catchErrors(userController.updateProfile));

export default router;
