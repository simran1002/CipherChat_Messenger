require("./setup");

const mongoose = require("mongoose");
const request = require("supertest");

let app, token, chatroomId;

beforeAll(async () => {
  await mongoose.connect(process.env.DATABASE);
  require("../dist/models/User");
  require("../dist/models/Chatroom");
  require("../dist/models/Message");
  require("../dist/models/DirectMessage");
  app = require("../dist/app").default;

  await request(app).post("/user/register").send({
    name: "Room Tester",
    email: "roomtest@test.cipher",
    password: "password123",
  });
  const loginRes = await request(app).post("/user/login").send({
    email: "roomtest@test.cipher",
    password: "password123",
  });
  token = loginRes.body.token;
}, 30000);

afterAll(async () => {
  const User = mongoose.model("User");
  const Chatroom = mongoose.model("Chatroom");
  const Message = mongoose.model("Message");
  await User.deleteMany({ email: /@test\.cipher$/ });
  await Chatroom.deleteMany({ name: /^TestRoom/ });
  if (chatroomId) await Message.deleteMany({ chatroom: chatroomId });
  await mongoose.connection.close();
}, 20000);

describe("GET /chatroom", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/chatroom");
    expect(res.status).toBe(401);
  });

  it("returns array for authenticated user", async () => {
    const res = await request(app).get("/chatroom").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("POST /chatroom", () => {
  it("creates a chatroom", async () => {
    const res = await request(app)
      .post("/chatroom")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "TestRoom-Jest" });
    expect(res.status).toBe(200);
    expect(res.body.chatroom).toHaveProperty("name", "TestRoom-Jest");
    chatroomId = res.body.chatroom._id;
  });

  it("rejects duplicate chatroom name", async () => {
    const res = await request(app)
      .post("/chatroom")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "TestRoom-Jest" });
    expect(res.status).toBe(409);
  });

  it("rejects invalid characters in name", async () => {
    const res = await request(app)
      .post("/chatroom")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Bad@Name!" });
    expect(res.status).toBe(400);
  });
});

describe("GET /chatroom/:id/messages", () => {
  it("returns messages with pagination info", async () => {
    const res = await request(app)
      .get(`/chatroom/${chatroomId}/messages`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("pagination");
  });

  it("rejects invalid chatroom id", async () => {
    const res = await request(app)
      .get("/chatroom/not-an-id/messages")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
