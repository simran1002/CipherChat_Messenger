const express = require("express");
const app = express();

// Increase body size limit
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Setup Cross Origin with allowed origins
const cors = require("cors");
app.use(cors({
  origin: [
    "http://localhost:3000", // local frontend
    "https://cipherchat-messenger.onrender.com" // deployed frontend (if any)
  ],
  credentials: true // only if you use cookies/auth
}));

//Bring in the routes
app.use("/user", require("./routes/user"));
app.use("/chatroom", require("./routes/chatroom"));

//Setup Error Handlers
const errorHandlers = require("./handlers/errorHandlers");
app.use(errorHandlers.notFound);
app.use(errorHandlers.mongoseErrors);
if (process.env.ENV === "DEVELOPMENT") {
  app.use(errorHandlers.developmentErrors);
} else {
  app.use(errorHandlers.productionErrors);
}

module.exports = app;
