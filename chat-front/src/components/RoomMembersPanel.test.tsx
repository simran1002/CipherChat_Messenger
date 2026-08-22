import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import RoomMembersPanel from "./RoomMembersPanel";
import api from "../services/api";
import { makeToast } from "../utils/toast";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getApiUrl: () => "http://localhost:8000",
}));

vi.mock("../utils/toast", () => ({ makeToast: vi.fn() }));

// framer-motion sets `opacity: 0` / transforms inline on first paint and only
// animates them away via rAF, which makes jest-dom's `toBeVisible` flaky in
// jsdom. Replace `motion.*` with plain elements (motion-only props stripped)
// and `AnimatePresence` with a pass-through so the DOM is stable and synchronous.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const MOTION_ONLY = new Set([
    "initial", "animate", "exit", "transition", "variants", "layout", "layoutId",
    "whileHover", "whileTap", "whileFocus", "whileDrag", "whileInView", "viewport",
    "drag", "dragConstraints", "onAnimationStart", "onAnimationComplete",
  ]);
  type AnyProps = Record<string, unknown>;
  const cache = new Map<string, React.ComponentType<AnyProps>>();
  const motion = new Proxy({} as Record<string, React.ComponentType<AnyProps>>, {
    get(_target, prop: string | symbol) {
      const tag = String(prop);
      let component = cache.get(tag);
      if (!component) {
        const Plain = React.forwardRef<HTMLElement, AnyProps>((props, ref) => {
          const domProps: AnyProps = { ref };
          for (const [k, v] of Object.entries(props)) if (!MOTION_ONLY.has(k)) domProps[k] = v;
          return React.createElement(tag, domProps);
        });
        Plain.displayName = `motion.${tag}`;
        component = Plain as unknown as React.ComponentType<AnyProps>;
        cache.set(tag, component);
      }
      return component;
    },
  });
  const AnimatePresence = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return { motion, AnimatePresence };
});

type ApiFn = (url: string, body?: unknown) => Promise<{ data: unknown }>;
const getMock = api.get as unknown as Mock<ApiFn>;
const postMock = api.post as unknown as Mock<ApiFn>;
const patchMock = api.patch as unknown as Mock<ApiFn>;
const toastMock = vi.mocked(makeToast);

const ROOM = "room-1";
const MEMBERS_URL = `/chatroom/${ROOM}/members`;

type RoomRole = "owner" | "admin" | "member";

const OWNER = { _id: "u-owner", name: "Olivia Owner", email: "olivia@example.com" };
const ADMIN = { _id: "u-admin", name: "Adam Admin" };
const MEMBER = { _id: "u-member", name: "Molly Member", isOnline: true };
const OUTSIDER = { _id: "u-new", name: "Nina New", email: "nina@example.com" };

const ID_BY_ROLE: Record<RoomRole, string> = { owner: OWNER._id, admin: ADMIN._id, member: MEMBER._id };

function membersPayload(myRole: RoomRole) {
  return {
    members: [
      { user: OWNER, role: "owner" },
      { user: ADMIN, role: "admin" },
      { user: MEMBER, role: "member" },
    ],
    isPrivate: true,
    myRole,
  };
}

/** Wire the api mock for a given viewer role and render the open panel. */
function setup(myRole: RoomRole, props: Partial<Parameters<typeof RoomMembersPanel>[0]> = {}) {
  localStorage.setItem("CC_User", JSON.stringify({ id: ID_BY_ROLE[myRole] }));
  getMock.mockImplementation(async (url) => {
    if (url === MEMBERS_URL) return { data: membersPayload(myRole) };
    if (url === "/dm/users") return { data: [OWNER, ADMIN, MEMBER, OUTSIDER] };
    throw new Error(`unexpected GET ${url}`);
  });
  postMock.mockResolvedValue({ data: {} });
  patchMock.mockResolvedValue({ data: {} });

  const onClose = vi.fn();
  const onLeft = vi.fn();
  const utils = render(
    <RoomMembersPanel chatroomId={ROOM} isOpen onClose={onClose} onLeft={onLeft} {...props} />
  );
  return { ...utils, onClose, onLeft };
}

const membersCalls = () => getMock.mock.calls.filter(([url]) => url === MEMBERS_URL);

describe("RoomMembersPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders nothing and fetches nothing while closed", () => {
    localStorage.setItem("CC_User", JSON.stringify({ id: OWNER._id }));
    const { container } = render(
      <RoomMembersPanel chatroomId={ROOM} isOpen={false} onClose={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("renders the member list from GET /chatroom/:id/members with names and role badges", async () => {
    setup("member");

    expect(await screen.findByText("Olivia Owner")).toBeInTheDocument();
    expect(screen.getByText("Adam Admin")).toBeInTheDocument();
    expect(screen.getByText("Molly Member")).toBeInTheDocument();
    expect(screen.getByText("olivia@example.com")).toBeInTheDocument();

    // Badge text is the raw role (uppercased only via CSS)
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("member")).toBeInTheDocument();

    // Header count + private badge + "(you)" marker on the current user
    expect(screen.getByText("(3)")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    const me = screen.getByText("Molly Member");
    expect(within(me).getByText("(you)")).toBeInTheDocument();

    expect(getMock).toHaveBeenCalledWith(MEMBERS_URL);
    expect(membersCalls()).toHaveLength(1);
  });

  it("shows the Invite section for owner and admin, hides it for member", async () => {
    const { unmount } = setup("owner");
    expect(await screen.findByText("Invite people")).toBeInTheDocument();
    unmount();

    vi.clearAllMocks();
    const { unmount: unmountAdmin } = setup("admin");
    expect(await screen.findByText("Invite people")).toBeInTheDocument();
    unmountAdmin();

    vi.clearAllMocks();
    setup("member");
    await screen.findByText("Olivia Owner");
    expect(screen.queryByText("Invite people")).not.toBeInTheDocument();
  });

  it("owner sees a role select for every OTHER member; admins and members see none", async () => {
    const { unmount } = setup("owner");
    await screen.findByText("Olivia Owner");

    expect(screen.getByLabelText("Change role for Adam Admin")).toBeInTheDocument();
    expect(screen.getByLabelText("Change role for Molly Member")).toBeInTheDocument();
    expect(screen.queryByLabelText("Change role for Olivia Owner")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    unmount();

    vi.clearAllMocks();
    const { unmount: unmountAdmin } = setup("admin");
    await screen.findByText("Olivia Owner");
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    unmountAdmin();

    vi.clearAllMocks();
    setup("member");
    await screen.findByText("Olivia Owner");
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });

  it("owner: role select PATCHes the member and refetches the list", async () => {
    setup("owner");
    await screen.findByText("Olivia Owner");

    fireEvent.change(screen.getByLabelText("Change role for Molly Member"), { target: { value: "admin" } });

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith(`/chatroom/${ROOM}/members/${MEMBER._id}`, { role: "admin" })
    );
    await waitFor(() => expect(membersCalls()).toHaveLength(2));
    expect(toastMock).toHaveBeenCalledWith("success", "Role updated");
  });

  it("owner: selecting 'Owner' asks for confirmation before transferring", async () => {
    setup("owner");
    await screen.findByText("Olivia Owner");

    fireEvent.change(screen.getByLabelText("Change role for Adam Admin"), { target: { value: "owner" } });

    expect(screen.getByText("Transfer ownership?")).toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith(`/chatroom/${ROOM}/members/${ADMIN._id}`, { role: "owner" })
    );
    await waitFor(() => expect(screen.queryByText("Transfer ownership?")).not.toBeInTheDocument());
    expect(toastMock).toHaveBeenCalledWith("success", "Ownership transferred to Adam Admin");
  });

  it("'Leave room' is disabled for the owner with a transfer hint", async () => {
    setup("owner");
    await screen.findByText("Olivia Owner");

    const leave = screen.getByRole("button", { name: /leave room/i });
    expect(leave).toBeDisabled();
    expect(leave).toHaveAttribute("title", "Transfer ownership first");
    expect(screen.getByText("Transfer ownership first")).toBeInTheDocument();
  });

  it("'Leave room' is enabled for admin and member", async () => {
    const { unmount } = setup("admin");
    await screen.findByText("Olivia Owner");
    expect(screen.getByRole("button", { name: /leave room/i })).toBeEnabled();
    unmount();

    vi.clearAllMocks();
    setup("member");
    await screen.findByText("Olivia Owner");
    expect(screen.getByRole("button", { name: /leave room/i })).toBeEnabled();
  });

  it("invite flow: loads the directory, excludes existing members, POSTs the userId and refetches", async () => {
    setup("owner");
    await screen.findByText("Olivia Owner");

    fireEvent.click(screen.getByText("Invite people"));

    // Directory is lazy-loaded on first open; existing members are filtered out
    expect(await screen.findByText("Nina New")).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith("/dm/users");
    // Exactly one invitable row (the three existing members are filtered out)
    const inviteButtons = screen.getAllByRole("button", { name: "Invite" });
    expect(inviteButtons).toHaveLength(1);
    expect(inviteButtons[0]!.parentElement).toHaveTextContent("Nina New");

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(`/chatroom/${ROOM}/invite`, { userId: OUTSIDER._id })
    );
    await waitFor(() => expect(membersCalls()).toHaveLength(2));
    expect(toastMock).toHaveBeenCalledWith("success", "Nina New invited");
  });

  it("invite search filters the directory by name/email", async () => {
    getMock.mockImplementation(async (url) => {
      if (url === MEMBERS_URL) return { data: { members: [{ user: OWNER, role: "owner" }], myRole: "owner" } };
      if (url === "/dm/users") return { data: [OWNER, ADMIN, OUTSIDER] };
      throw new Error(`unexpected GET ${url}`);
    });
    localStorage.setItem("CC_User", JSON.stringify({ id: OWNER._id }));
    render(<RoomMembersPanel chatroomId={ROOM} isOpen onClose={vi.fn()} />);
    await screen.findByText("Olivia Owner");

    fireEvent.click(screen.getByText("Invite people"));
    await screen.findByText("Nina New");
    expect(screen.getByText("Adam Admin")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search users…"), { target: { value: "nina@" } });
    expect(screen.getByText("Nina New")).toBeInTheDocument();
    expect(screen.queryByText("Adam Admin")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search users…"), { target: { value: "zzz" } });
    expect(screen.getByText("No users to invite")).toBeInTheDocument();
  });

  it("leave: POSTs /chatroom/:id/leave then calls onClose and onLeft", async () => {
    const { onClose, onLeft } = setup("member");
    await screen.findByText("Olivia Owner");

    fireEvent.click(screen.getByRole("button", { name: /leave room/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/chatroom/${ROOM}/leave`));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith("success", "You left the room");
  });

  it("leave failure: surfaces the server message and does NOT close", async () => {
    const { onClose, onLeft } = setup("member");
    await screen.findByText("Olivia Owner");
    postMock.mockRejectedValueOnce({ response: { data: { message: "Owner must transfer first" } } });

    fireEvent.click(screen.getByRole("button", { name: /leave room/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("error", "Owner must transfer first"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /leave room/i })).toBeEnabled();
  });

  it("close button calls onClose", async () => {
    const { onClose } = setup("member");
    await screen.findByText("Olivia Owner");

    fireEvent.click(screen.getByRole("button", { name: "Close members panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toasts when the member list fails to load", async () => {
    localStorage.setItem("CC_User", JSON.stringify({ id: OWNER._id }));
    getMock.mockRejectedValue(new Error("network down"));
    render(<RoomMembersPanel chatroomId={ROOM} isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("error", "Failed to load members"));
    // No role known → no footer / leave button
    expect(screen.queryByRole("button", { name: /leave room/i })).not.toBeInTheDocument();
  });
});
