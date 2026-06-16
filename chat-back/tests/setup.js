require("dotenv").config();
// Override DB to a test database so tests never touch production data
process.env.DATABASE = process.env.TEST_DATABASE || process.env.DATABASE + "_test";
process.env.SECRET = "test-secret-key-that-is-at-least-32-chars-long";
process.env.ENV = "TEST";
