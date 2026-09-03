import { useState, useEffect, useRef, useCallback, type ChangeEvent } from "react";
import { motion } from "framer-motion";
import { CameraIcon, CheckIcon, PencilIcon, ComputerDesktopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import api, { apiErrorMessage, getApiUrl } from "../services/api";
import { makeToast } from "../utils/toast";
import { stringToColor, getInitials } from "../utils/helpers";
import TwoFactorSettings from "../components/TwoFactorSettings";
import type { AuthUser } from "../types";

interface ProfilePageProps {
  user: AuthUser | null;
  setUser: (u: AuthUser) => void;
}

interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  createdByIp: string;
  current: boolean;
}

/**
 * Active sessions — one row per signed-in browser (each is a refresh-token
 * row server-side). Revoking a row kills that browser's ability to refresh;
 * its 15-minute access token expires on its own.
 */
function ActiveSessions() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/api/v1/auth/sessions");
      setSessions(res.data as SessionRow[]);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await api.delete(`/api/v1/auth/sessions/${id}`);
      makeToast("success", "Session signed out");
      await load();
    } catch {
      makeToast("error", "Failed to revoke session");
    } finally {
      setBusy(null);
    }
  };

  const revokeOthers = async () => {
    setBusy("others");
    try {
      const res = await api.delete("/api/v1/auth/sessions");
      makeToast("success", (res.data as { message?: string }).message || "Signed out elsewhere");
      await load();
    } catch {
      makeToast("error", "Failed to sign out other sessions");
    } finally {
      setBusy(null);
    }
  };

  if (sessions === null) return null;
  const others = sessions.filter((s) => !s.current).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="w-full max-w-md mt-4 bg-gray-800/80 backdrop-blur-sm border border-gray-700/50 rounded-3xl shadow-2xl p-5"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <ComputerDesktopIcon className="w-4 h-4 text-violet-400" />
          Active sessions
          <span className="text-xs text-gray-500">({sessions.length})</span>
        </h3>
        {others > 0 && (
          <button
            onClick={revokeOthers}
            disabled={busy !== null}
            className="text-xs px-3 py-1.5 rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 border border-rose-500/30 transition-colors disabled:opacity-50"
          >
            Sign out everywhere else
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-xl bg-gray-900/50 border border-gray-700/40 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-xs text-gray-200 truncate">
                {s.current ? (
                  <span className="text-emerald-400 font-medium">This browser</span>
                ) : (
                  <span>Signed in {new Date(s.createdAt).toLocaleString()}</span>
                )}
              </p>
              <p className="text-[11px] text-gray-500 truncate">
                {s.createdByIp || "unknown IP"} · expires {new Date(s.expiresAt).toLocaleDateString()}
              </p>
            </div>
            {!s.current && (
              <button
                onClick={() => revoke(s.id)}
                disabled={busy !== null}
                title="Sign out this session"
                className="p-1.5 rounded-lg text-gray-400 hover:text-rose-300 hover:bg-rose-600/10 transition-colors disabled:opacity-50"
              >
                <XMarkIcon className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

const ProfilePage = ({ setUser }: ProfilePageProps) => {
  const [profile, setProfile] = useState<AuthUser | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [dpFile, setDpFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get("/api/v1/users/me").then((r) => {
      const data = r.data as AuthUser;
      setProfile(data);
      setName(data.name);
      setBio(data.bio || "");
      // 2FA state lives with auth, not the profile — one extra call keeps the card truthful on load.
      return api
        .get<{ enabled: boolean }>("/api/v1/auth/2fa/status")
        .then((s) => setProfile({ ...data, twoFactorEnabled: s.data.enabled }))
        .catch(() => {});
    });
  }, []);

  const handleDpChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDpFile(file);
    setPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // The Java backend splits this into two calls: upload the file to get a
      // durable URL (POST /api/v1/uploads), then PATCH the profile fields —
      // there's no single multipart "profile + avatar" endpoint any more.
      let dp: string | undefined;
      if (dpFile) {
        const fd = new FormData();
        fd.append("file", dpFile);
        const uploaded = await api.post<{ url: string }>("/api/v1/uploads", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        dp = uploaded.data.url;
      }
      const res = await api.patch<AuthUser>("/api/v1/users/me", { name, bio, ...(dp ? { dp } : {}) });
      const updated = res.data;
      setProfile(updated);
      setUser(updated);
      localStorage.setItem("CC_User", JSON.stringify(updated));
      setEditing(false);
      setDpFile(null);
      setPreview(null);
      makeToast("success", "Profile updated");
    } catch (err) {
      makeToast("error", apiErrorMessage(err, "Failed to update"));
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-950 to-gray-900 flex items-center justify-center">
      <div className="w-10 h-10 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const dpSrc = preview || (profile.dp ? (profile.dp.startsWith("http") ? profile.dp : `${getApiUrl()}${profile.dp}`) : null);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-950/30 to-gray-900 flex flex-col items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-gray-800/80 backdrop-blur-sm border border-gray-700/50 rounded-3xl overflow-hidden shadow-2xl"
      >
        {/* Cover gradient */}
        <div className="h-28 bg-gradient-to-br from-violet-600 via-purple-700 to-indigo-800 relative">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2">
            <div className="relative">
              {dpSrc ? (
                <img src={dpSrc} alt={profile.name} className="w-20 h-20 rounded-full border-4 border-gray-800 object-cover" />
              ) : (
                <div className="w-20 h-20 rounded-full border-4 border-gray-800 flex items-center justify-center text-2xl font-bold text-white" style={{ background: stringToColor(profile.name) }}>
                  {getInitials(profile.name)}
                </div>
              )}
              {editing && (
                <button onClick={() => fileRef.current?.click()} className="absolute inset-0 bg-black/50 rounded-full flex items-center justify-center hover:bg-black/60 transition-colors">
                  <CameraIcon className="w-6 h-6 text-white" />
                </button>
              )}
            </div>
          </div>
        </div>

        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleDpChange} />

        <div className="pt-14 px-6 pb-6">
          {editing ? (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Display name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={50}
                  className="w-full bg-gray-700 border border-gray-600 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-gray-200 outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Bio <span className="text-gray-600">({bio.length}/160)</span></label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={160}
                  rows={3}
                  placeholder="Something about yourself…"
                  className="w-full bg-gray-700 border border-gray-600 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-gray-200 outline-none resize-none"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setEditing(false); setName(profile.name); setBio(profile.bio || ""); setPreview(null); setDpFile(null); }} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-300 transition-colors">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving} className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm text-white transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60">
                  {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <CheckIcon className="w-4 h-4" />}
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <h2 className="text-xl font-bold text-white">{profile.name}</h2>
              <p className="text-sm text-gray-400 mt-0.5">{profile.email}</p>
              {profile.bio && <p className="text-sm text-gray-300 mt-3 leading-relaxed">{profile.bio}</p>}
              <div className="flex items-center justify-center gap-1.5 mt-2 text-xs text-violet-400">
                <LockClosedIcon className="w-3 h-3" />
                <span>End-to-end encrypted</span>
              </div>
              <button onClick={() => setEditing(true)} className="mt-4 flex items-center gap-2 mx-auto px-5 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-300 transition-colors">
                <PencilIcon className="w-4 h-4" /> Edit Profile
              </button>
            </div>
          )}
        </div>
      </motion.div>
      {profile && <TwoFactorSettings initialEnabled={Boolean(profile.twoFactorEnabled)} />}
      <ActiveSessions />
    </div>
  );
};

export default ProfilePage;
