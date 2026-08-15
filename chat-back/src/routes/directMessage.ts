import { Router } from "express";
import { catchErrors } from "../middlewares/errorHandlers.js";
import * as dmController from "../controllers/directMessageController.js";
import auth from "../middlewares/auth.js";

const router = Router();

router.get("/", auth, catchErrors(dmController.getConversations));
router.post("/start", auth, catchErrors(dmController.startConversation));
router.get("/users", auth, catchErrors(dmController.getUsers));
router.get("/:conversationId/messages", auth, catchErrors(dmController.getMessages));

export default router;
