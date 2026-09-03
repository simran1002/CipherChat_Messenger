/**
 * Room members panel — membership list, roles, invite, leave.
 * Slide-over from the right; data from GET /api/v1/chatrooms/:id/members.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  XMarkIcon,
  UsersIcon,
  UserPlusIcon,
  MagnifyingGlassIcon,
  ArrowRightOnRectangleIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import api, { apiErrorMessage, getApiUrl } from "../services/api";
import { makeToast } from "../utils/toast";
import { stringToColor, getInitials } from "../utils/helpers";

export interface RoomMembersPanelProps {
  chatroomId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Called after the current user leaves the room (navigate away). */
  onLeft?: () => void;
}

type RoomRole = "owner" | "admin" | "member";

/** ChatroomDtos.MemberView: `user` is the id/name/dp summary; email and online state ride alongside it. */
interface MemberUser {
  id: string;
  name: string;
  dp?: string;
}

interface RoomMember {
  user: MemberUser;
  email?: string;
  isOnline?: boolean;
  role: RoomRole;
  joinedAt?: string;
}

interface MembersResponse {
  members: RoomMember[];
  isPrivate?: boolean;
  myRole: RoomRole | null;
}

/** GET /api/v1/users row (UserView) — has email, unlike a room member row. */
interface DirectoryUser {
  id: string;
  name: string;
  email?: string;
  dp?: string;
}

const ROLE_BADGE: Record<RoomRole, string> = {
  owner: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  admin: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  member: "bg-gray-600/20 text-gray-400 border-gray-600/40",
};

function MemberAvatar({ user, sizeClass = "w-9 h-9" }: { user: { name: string; dp?: string }; sizeClass?: string }) {
  const dpSrc = user.dp ? (user.dp.startsWith("http") ? user.dp : `${getApiUrl()}${user.dp}`) : null;
  if (dpSrc) return <img src={dpSrc} alt="" className={`${sizeClass} rounded-full object-cover ring-2 ring-violet-500/20`} />;
  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center text-white font-semibold text-sm ring-2 ring-violet-500/20`}
      style={{ background: `linear-gradient(135deg, ${stringToColor(user.name)}, #8b5cf6)` }}
    >
      {getInitials(user.name)}
    </div>
  );
}

const RoomMembersPanel = ({ chatroomId, isOpen, onClose, onLeft }: RoomMembersPanelProps) => {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [myRole, setMyRole] = useState<RoomRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [allUsers, setAllUsers] = useState<DirectoryUser[] | null>(null);
  const [inviteSearch, setInviteSearch] = useState("");
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [transferTarget, setTransferTarget] = useState<RoomMember | null>(null);
  const [savingRole, setSavingRole] = useState(false);

  const myId = useMemo(() => {
    try {
      return (JSON.parse(localStorage.getItem("CC_User") || "{}") as { id?: string }).id ?? null;
    } catch {
      return null;
    }
  }, []);

  const fetchMembers = useCallback(async () => {
    try {
      const res = await api.get(`/api/v1/chatrooms/${chatroomId}/members`);
      const data = res.data as MembersResponse;
      setMembers(data.members);
      setIsPrivate(Boolean(data.isPrivate));
      setMyRole(data.myRole);
    } catch (err) {
      makeToast("error", apiErrorMessage(err, "Failed to load members"));
    } finally {
      setLoading(false);
    }
  }, [chatroomId]);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    void fetchMembers();
  }, [isOpen, fetchMembers]);

  // Lazy-load the user directory the first time the invite section opens
  useEffect(() => {
    if (!showInvite || allUsers !== null) return;
    api
      .get("/api/v1/users")
      .then((res) => setAllUsers(res.data as DirectoryUser[]))
      .catch((err) => makeToast("error", apiErrorMessage(err, "Failed to load users")));
  }, [showInvite, allUsers]);

  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  const invitableUsers = useMemo(() => {
    if (!allUsers) return [];
    const memberIds = new Set(members.map((m) => m.user.id));
    const q = inviteSearch.trim().toLowerCase();
    return allUsers
      .filter((u) => !memberIds.has(u.id))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q));
  }, [allUsers, members, inviteSearch]);

  const handleInvite = async (user: DirectoryUser) => {
    setInvitingId(user.id);
    try {
      const res = await api.post(`/api/v1/chatrooms/${chatroomId}/invite`, { userId: user.id });
      makeToast("success", (res.data as { message?: string }).message || `${user.name} invited`);
      await fetchMembers();
    } catch (err) {
      makeToast("error", apiErrorMessage(err, "Failed to invite user"));
    } finally {
      setInvitingId(null);
    }
  };

  const applyRole = async (member: RoomMember, role: RoomRole) => {
    setSavingRole(true);
    try {
      await api.patch(`/api/v1/chatrooms/${chatroomId}/members/${member.user.id}`, { role });
      makeToast("success", role === "owner" ? `Ownership transferred to ${member.user.name}` : "Role updated");
      await fetchMembers();
    } catch (err) {
      makeToast("error", apiErrorMessage(err, "Failed to update role"));
    } finally {
      setSavingRole(false);
      setTransferTarget(null);
    }
  };

  const handleRoleChange = (member: RoomMember, role: RoomRole) => {
    if (role === member.role) return;
    if (role === "owner") {
      setTransferTarget(member);
      return;
    }
    void applyRole(member, role);
  };

  const handleLeave = async () => {
    setLeaving(true);
    try {
      await api.post(`/api/v1/chatrooms/${chatroomId}/leave`);
      makeToast("success", "You left the room");
      onClose();
      onLeft?.();
    } catch (err) {
      makeToast("error", apiErrorMessage(err, "Failed to leave the room"));
    } finally {
      setLeaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-end"
          onClick={onClose}
        >
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.25 }}
            className="relative w-full max-w-sm h-full bg-gray-900/95 backdrop-blur-md border-l border-gray-700/50 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700/50">
              <div className="flex items-center gap-2">
                <UsersIcon className="w-5 h-5 text-violet-400" />
                <h2 className="text-base font-semibold text-white">Members</h2>
                <span className="text-xs text-gray-500">({members.length})</span>
                {isPrivate && (
                  <span className="flex items-center gap-1 text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/30 rounded-full px-2 py-0.5">
                    <LockClosedIcon className="w-3 h-3" /> Private
                  </span>
                )}
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors" aria-label="Close members panel">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="w-8 h-8 border-4 border-violet-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <>
                  {/* Invite section (owner/admin) */}
                  {canManage && (
                    <div className="px-5 py-3 border-b border-gray-700/50">
                      <button
                        onClick={() => setShowInvite((v) => !v)}
                        className="w-full flex items-center gap-2 text-sm font-medium text-violet-400 hover:text-violet-300 transition-colors"
                      >
                        <UserPlusIcon className="w-4 h-4" />
                        <span>Invite people</span>
                      </button>
                      <AnimatePresence>
                        {showInvite && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="relative mt-3">
                              <MagnifyingGlassIcon className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                              <input
                                type="text"
                                value={inviteSearch}
                                onChange={(e) => setInviteSearch(e.target.value)}
                                placeholder="Search users…"
                                className="w-full bg-gray-800/70 border border-gray-700 text-sm text-gray-200 rounded-xl pl-9 pr-3 py-2 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 placeholder-gray-500 transition-all"
                              />
                            </div>
                            <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
                              {allUsers === null ? (
                                <p className="text-xs text-gray-500 py-2 text-center">Loading users…</p>
                              ) : invitableUsers.length === 0 ? (
                                <p className="text-xs text-gray-500 py-2 text-center">No users to invite</p>
                              ) : (
                                invitableUsers.map((u) => (
                                  <div key={u.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-gray-800/70 transition-colors">
                                    <MemberAvatar user={u} sizeClass="w-7 h-7" />
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm text-gray-200 truncate">{u.name}</p>
                                      {u.email && <p className="text-[11px] text-gray-500 truncate">{u.email}</p>}
                                    </div>
                                    <button
                                      onClick={() => void handleInvite(u)}
                                      disabled={invitingId === u.id}
                                      className="text-xs font-medium text-violet-400 hover:text-violet-300 border border-violet-500/30 hover:border-violet-500/60 rounded-lg px-2.5 py-1 disabled:opacity-50 transition-all"
                                    >
                                      {invitingId === u.id ? "Adding…" : "Invite"}
                                    </button>
                                  </div>
                                ))
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Member list */}
                  <ul className="px-3 py-2">
                    {members.map((m) => (
                      <li key={m.user.id} className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-gray-800/50 transition-colors">
                        <div className="relative shrink-0">
                          <MemberAvatar user={m.user} />
                          {m.isOnline && (
                            <span
                              className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-gray-900"
                              aria-label="online"
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-200 truncate">
                            {m.user.name}
                            {m.user.id === myId && <span className="text-gray-500 font-normal"> (you)</span>}
                          </p>
                          {m.email && <p className="text-[11px] text-gray-500 truncate">{m.email}</p>}
                        </div>
                        <span className={`text-[10px] font-semibold uppercase tracking-wide border rounded-full px-2 py-0.5 shrink-0 ${ROLE_BADGE[m.role]}`}>
                          {m.role}
                        </span>
                        {isOwner && m.user.id !== myId && (
                          <select
                            value={m.role}
                            disabled={savingRole}
                            onChange={(e) => handleRoleChange(m, e.target.value as RoomRole)}
                            aria-label={`Change role for ${m.user.name}`}
                            className="bg-gray-800 border border-gray-700 text-xs text-gray-300 rounded-lg px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 shrink-0"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                            <option value="owner">Owner</option>
                          </select>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            {/* Footer — leave room */}
            {myRole && (
              <div className="px-5 py-4 border-t border-gray-700/50">
                <button
                  onClick={() => void handleLeave()}
                  disabled={isOwner || leaving}
                  title={isOwner ? "Transfer ownership first" : undefined}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-red-400 border border-red-500/30 hover:bg-red-500/10 hover:border-red-500/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all"
                >
                  <ArrowRightOnRectangleIcon className="w-4 h-4" />
                  <span>{leaving ? "Leaving…" : "Leave room"}</span>
                </button>
                {isOwner && (
                  <p className="text-[11px] text-gray-600 text-center mt-1.5">Transfer ownership first</p>
                )}
              </div>
            )}

            {/* Ownership transfer confirm */}
            <AnimatePresence>
              {transferTarget && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 z-10"
                >
                  <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    className="bg-gray-800 border border-gray-700 rounded-2xl p-5 w-full shadow-2xl"
                  >
                    <h3 className="text-base font-semibold text-white mb-2">Transfer ownership?</h3>
                    <p className="text-sm text-gray-400 mb-4">
                      <span className="text-amber-400 font-medium">{transferTarget.user.name}</span> will become the owner
                      of this room. You will become an admin.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTransferTarget(null)}
                        disabled={savingRole}
                        className="flex-1 py-2 rounded-xl border border-gray-600 text-sm text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-50 transition-all"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => transferTarget && void applyRole(transferTarget, "owner")}
                        disabled={savingRole}
                        className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-sm font-medium text-gray-900 disabled:opacity-50 transition-all"
                      >
                        {savingRole ? "Transferring…" : "Transfer"}
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default RoomMembersPanel;
