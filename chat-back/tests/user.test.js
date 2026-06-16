require("./setup");

const mongoose = require("mongoose");
const request = require("supertest");

let app;

beforeAll(async () => {
  await mongoose.connect(process.env.DATABASE);
  require("../models/User");
  require("../models/Chatroom");
  require("../models/Message");
  require("../models/DirectMessage");
  app = require("../app");
});

afterAll(async () => {
  const User = mongoose.model("User");
  await User.deleteMany({ email: /@test\.cipher$/ });
  await mongoose.connection.close();
});

const testUser = {
  name: "Test User",
  email: "testuser@test.cipher",
  password: "password123",
};

describe("POST /user/register", () => {
  it("registers a new user successfully", async () => {
    const res = await request(app).post("/user/register").send(testUser);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/registered/i);
  });

  it("rejects duplicate email", async () => {
    const res = await request(app).post("/user/register").send(testUser);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it("rejects missing fields", async () => {
    const res = await request(app).post("/user/register").send({ email: "x@x.com" });
    expect(res.status).toBe(400);
  });

  it("rejects short password", async () => {
    const res = await request(app).post("/user/register").send({
      name: "X", email: "short@test.cipher", password: "abc",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/6 characters/i);
  });

  it("rejects invalid email format", async () => {
    const res = await request(app).post("/user/register").send({
      name: "X", email: "not-an-email", password: "password123",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /user/login", () => {
  it("logs in with valid credentials", async () => {
    const res = await request(app).post("/user/login").send({
      email: testUser.email,
      password: testUser.password,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.user).toHaveProperty("email", testUser.email);
  });

  it("rejects wrong password", async () => {
    const res = await request(app).post("/user/login").send({
      email: testUser.email,
      password: "wrongpassword",
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown email", async () => {
    const res = await request(app).post("/user/login").send({
      email: "nobody@test.cipher",
      password: "password123",
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing credentials", async () => {
    const res = await request(app).post("/user/login").send({});
    expect(res.status).toBe(400);
  });
});
