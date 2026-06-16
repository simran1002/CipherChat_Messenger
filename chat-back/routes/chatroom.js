const router = require("express").Router();
const { catchErrors } = require("../handlers/errorHandlers");
const chatroomController = require("../controllers/chatroomController");
const auth = require("../middlewares/auth");

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

module.exports = router;
