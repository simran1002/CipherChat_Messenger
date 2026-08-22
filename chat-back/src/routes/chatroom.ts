import { Router } from "express";
import { catchErrors } from "../middlewares/errorHandlers.js";
import * as chatroomController from "../controllers/chatroomController.js";
import auth from "../middlewares/auth.js";

const router = Router();

router.get("/", auth, catchErrors(chatroomController.getAllChatrooms));
router.post("/", auth, catchErrors(chatroomController.createChatroom));
router.get("/:chatroomId/messages", auth, catchErrors(chatroomController.getChatroomMessages));
router.get("/:chatroomId/messages/search", auth, catchErrors(chatroomController.searchMessages));
router.get("/:chatroomId/pinned", auth, catchErrors(chatroomController.getPinnedMessages));
router.put("/messages/:messageId", auth, catchErrors(chatroomController.editMessage));
router.delete("/messages/:messageId", auth, catchErrors(chatroomController.deleteMessage));
router.post("/messages/:messageId/pin", auth, catchErrors(chatroomController.pinMessage));
router.post("/messages/:messageId/react", auth, catchErrors(chatroomController.toggleReaction));

// Read receipts — mark all messages in a room as read up to (and including) a sequence number
router.post("/:chatroomId/read", auth, catchErrors(chatroomController.markRead));
// Delivery receipt — confirm a specific message was received on-device
router.post("/messages/:messageId/delivered", auth, catchErrors(chatroomController.markDelivered));

// Membership & roles
router.get("/:chatroomId/members", auth, catchErrors(chatroomController.getMembers));
router.post("/:chatroomId/join", auth, catchErrors(chatroomController.joinRoom));
router.post("/:chatroomId/invite", auth, catchErrors(chatroomController.inviteMember));
router.post("/:chatroomId/leave", auth, catchErrors(chatroomController.leaveRoom));
router.patch("/:chatroomId/members/:userId", auth, catchErrors(chatroomController.updateMemberRole));

export default router;
