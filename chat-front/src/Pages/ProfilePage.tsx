import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { motion } from "framer-motion";
import { CameraIcon, CheckIcon, PencilIcon } from "@heroicons/react/24/outline";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import api, { getApiUrl } from "../services/api";
import { makeToast } from "../utils/toast";
import { stringToColor, getInitials } from "../utils/helpers";
import type { AuthUser } from "../types";

interface ProfilePageProps {
  user: AuthUser | null;
  setUser: (u: AuthUser) => void;
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
    api.get("/user/profile").then((r) => {
      const data = r.data as AuthUser;
      setProfile(data);
      setName(data.name);
      setBio(data.bio || "");
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
      const fd = new FormData();
      fd.append("name", name);
      fd.append("bio", bio);
      if (dpFile) fd.append("dp", dpFile);
      const res = await api.put("/user/profile", fd, { headers: { "Content-Type": "multipart/form-data" } });
      const updated = res.data.user as AuthUser;
      setProfile(updated);
      setUser(updated);
      localStorage.setItem("CC_User", JSON.stringify(updated));
      setEditing(false);
      setDpFile(null);
      setPreview(null);
      makeToast("success", "Profile updated");
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      makeToast("error", message || "Failed to update");
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
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-950/30 to-gray-900 flex items-center justify-center p-4">
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
    </div>
  );
};

export default ProfilePage;
