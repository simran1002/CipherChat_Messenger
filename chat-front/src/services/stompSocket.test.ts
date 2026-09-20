import { beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of stompjs' Client to drive the connect/disconnect lifecycle by hand. */
const h = vi.hoisted(() => {
  const instances: FakeClient[] = [];
  class FakeClient {
    connected = false;
    onConnect?: () => void;
    onWebSocketClose?: (e: unknown) => void;
    onStompError?: (f: unknown) => void;
    onWebSocketError?: () => void;
    connectHeaders: Record<string, string> = {};
    subscribed: string[] = [];
    unsubscribed: string[] = [];
    throwOnUnsubscribe = false;

    constructor(public config: unknown) {
      instances.push(this);
    }
    activate(): void {}
    deactivate(): void {}
    publish(): void {}
    subscribe(destination: string) {
      this.subscribed.push(destination);
      return {
        id: destination,
        unsubscribe: () => {
          if (this.throwOnUnsubscribe) throw new Error("There is no underlying STOMP connection");
          this.unsubscribed.push(destination);
        },
      };
    }
    /** The socket finishes connecting. */
    open(): void {
      this.connected = true;
      this.onConnect?.();
    }
    /** The network drops. */
    drop(): void {
      this.connected = false;
    }
  }
  return { FakeClient, instances };
});

vi.mock("@stomp/stompjs", () => ({ Client: h.FakeClient }));

import { createStompSocket } from "./stompSocket";

const count = (list: string[], destination: string) => list.filter((d) => d === destination).length;

describe("stompSocket join/leave", () => {
  beforeEach(() => {
    h.instances.length = 0;
  });

  function connectedSocket() {
    const socket = createStompSocket("http://localhost:8080");
    const client = h.instances[0]!;
    return { socket, client };
  }

  it("a join issued before the socket has connected is honoured the moment it does — a hard refresh or deep link joins at mount", () => {
    const { socket, client } = connectedSocket();

    socket.emit("joinRoom", { chatroomId: "room-1" });
    socket.emit("joinDM", { conversationId: "conv-1" });
    expect(client.subscribed).not.toContain("/topic/rooms/room-1"); // nothing can be subscribed yet...

    client.open();

    expect(client.subscribed).toContain("/topic/rooms/room-1"); // ...but the wish was remembered, not dropped
    expect(client.subscribed).toContain("/topic/dm/conv-1");
  });

  it("every joined room and conversation is re-established once per reconnect, never duplicated", () => {
    const { socket, client } = connectedSocket();
    client.open();
    socket.emit("joinRoom", { chatroomId: "room-1" });
    socket.emit("joinRoom", { chatroomId: "room-1" }); // joining twice on one connection subscribes once
    expect(count(client.subscribed, "/topic/rooms/room-1")).toBe(1);

    client.drop();
    client.open();

    expect(count(client.subscribed, "/topic/rooms/room-1")).toBe(2); // one per connection
  });

  it("leaving while the connection is down does not throw, and the room is not resurrected on reconnect", () => {
    const { socket, client } = connectedSocket();
    client.open();
    socket.emit("joinRoom", { chatroomId: "room-1" });
    socket.emit("joinDM", { conversationId: "conv-1" });

    client.drop();
    client.throwOnUnsubscribe = true; // stompjs throws when asked to unsubscribe with no connection
    expect(() => socket.emit("leaveRoom", { chatroomId: "room-1" })).not.toThrow();
    expect(() => socket.emit("leaveDM", { conversationId: "conv-1" })).not.toThrow();

    client.throwOnUnsubscribe = false;
    client.open();

    expect(count(client.subscribed, "/topic/rooms/room-1")).toBe(1); // only the original subscription
    expect(count(client.subscribed, "/topic/dm/conv-1")).toBe(1);
  });

  it("leaving while connected unsubscribes on the broker", () => {
    const { socket, client } = connectedSocket();
    client.open();
    socket.emit("joinRoom", { chatroomId: "room-1" });

    socket.emit("leaveRoom", { chatroomId: "room-1" });

    expect(client.unsubscribed).toContain("/topic/rooms/room-1");
  });
});
