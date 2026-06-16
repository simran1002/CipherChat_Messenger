const router = require("express").Router();
const { catchErrors } = require("../handlers/errorHandlers");
const dmController = require("../controllers/directMessageController");
const auth = require("../middlewares/auth");

router.get("/", auth, catchErrors(dmController.getConversations));
router.post("/start", auth, catchErrors(dmController.startConversation));
router.get("/users", auth, catchErrors(dmController.getUsers));
router.get("/:conversationId/messages", auth, catchErrors(dmController.getMessages));

module.exports = router;
