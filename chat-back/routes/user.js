const router = require("express").Router();
const { catchErrors } = require("../handlers/errorHandlers");
const userController = require("../controllers/userController");
const auth = require("../middlewares/auth");
const upload = require("../middlewares/upload");

router.post("/login", catchErrors(userController.login));
router.post("/register", catchErrors(userController.register));
router.get("/profile", auth, catchErrors(userController.getProfile));
router.put("/profile", auth, upload.single("dp"), catchErrors(userController.updateProfile));

module.exports = router;
