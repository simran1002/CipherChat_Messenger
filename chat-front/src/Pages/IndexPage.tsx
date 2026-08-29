import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ChatBubbleLeftRightIcon,
  ShieldCheckIcon,
  BoltIcon,
  ArrowRightIcon,
  ServerStackIcon,
  ChartBarIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  FingerPrintIcon,
} from "@heroicons/react/24/outline";

/**
 * The landing page sells the engineering, not adjectives: each card states a
 * guarantee and the mechanism/proof behind it, mirroring the README's
 * "four load-bearing guarantees".
 */
const guarantees = [
  {
    icon: BoltIcon,
    title: "Exactly-once delivery",
    description:
      "Client UUIDs, ACK + retry with backoff, an offline IndexedDB queue, Redis dedup and per-room sequences — with unique DB indexes as the final backstop. Kill a server pod mid-conversation: zero messages lost, zero duplicated.",
    color: "from-yellow-500 to-orange-500",
  },
  {
    icon: ShieldCheckIcon,
    title: "DMs the server can't read",
    description:
      "X3DH-lite key agreement, per-direction HMAC chains, AES-256-GCM bound to its routing metadata. Crypto pinned to RFC & NIST test vectors. The database stores ciphertext — even the operator sees nothing.",
    color: "from-violet-500 to-fuchsia-500",
  },
  {
    icon: PaperClipIcon,
    title: "Encrypted attachments",
    description:
      "Every file is sealed with its own key before upload. The server stores an opaque blob and learns neither the content nor the file type — name, size and key travel only inside the encrypted envelope.",
    color: "from-blue-500 to-cyan-500",
  },
  {
    icon: ServerStackIcon,
    title: "Survives failure",
    description:
      "Replicas behind a load balancer share state through Redis: sequences, rate limits, presence, socket fan-out. Rolling deploys drain gracefully; reconnecting clients replay their queue and dedup absorbs it.",
    color: "from-red-500 to-rose-500",
  },
  {
    icon: ChartBarIcon,
    title: "Observability without snooping",
    description:
      "Live p50/p95/p99 latency, delivery rates and concurrency — every metric passes one test: could this line reveal what someone said? Counts, latencies and outcomes only.",
    color: "from-green-500 to-emerald-500",
  },
  {
    icon: FingerPrintIcon,
    title: "Sessions you control",
    description:
      "15-minute access tokens with rotating refresh cookies — replaying a rotated token is treated as theft and revoked. See every signed-in device and sign out everywhere else, remotely.",
    color: "from-indigo-500 to-violet-500",
  },
];

const stats = [
  { value: "176 ms", label: "ACK p95 under load" },
  { value: "266", label: "automated tests" },
  { value: "60/60", label: "messages survive a pod kill" },
  { value: "AES-256", label: "GCM, RFC-vectored" },
];

const IndexPage = () => {
  return (
    <div className="min-h-screen bg-gray-900 relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-primary-500/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-[600px] h-[600px] bg-secondary-500/5 rounded-full blur-3xl" />
        <div className="absolute top-1/3 right-1/4 w-[300px] h-[300px] bg-primary-500/3 rounded-full blur-3xl" />
      </div>

      {/* Hero Section */}
      <section className="relative z-10 pt-20 pb-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-4xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              <div className="inline-flex items-center gap-2 bg-primary-500/10 border border-primary-500/20 rounded-full px-4 py-1.5 mb-8">
                <LockClosedIcon className="w-3.5 h-3.5 text-primary-300" />
                <span className="text-primary-300 text-sm font-medium">
                  End-to-end encrypted · exactly-once delivery
                </span>
              </div>
              <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold text-white mb-6 leading-tight">
                Messaging that
                <span className="block bg-gradient-to-r from-primary-400 to-secondary-400 bg-clip-text text-transparent">
                  proves its guarantees
                </span>
              </h1>
              <p className="text-lg sm:text-xl text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
                Self-hostable secure team messaging for people who can&apos;t put
                sensitive conversations in someone else&apos;s cloud. Private
                messages even the server admin can&apos;t read — and delivery
                you can watch survive a server being killed mid-sentence.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Link
                    to="/register"
                    className="inline-flex items-center space-x-2 bg-gradient-to-r from-primary-500 to-secondary-500 hover:from-primary-600 hover:to-secondary-600 text-white font-semibold text-lg px-8 py-4 rounded-xl shadow-lg shadow-primary-500/25 transition-all"
                  >
                    <span>Start Chatting</span>
                    <PaperAirplaneIcon className="w-5 h-5" />
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Link
                    to="/login"
                    className="inline-flex items-center space-x-2 border border-gray-600 hover:border-primary-500 text-gray-300 hover:text-white font-semibold text-lg px-8 py-4 rounded-xl hover:bg-primary-500/10 transition-all"
                  >
                    <span>Sign In</span>
                    <LockClosedIcon className="w-5 h-5" />
                  </Link>
                </motion.div>
              </div>
            </motion.div>

            {/* Stat strip — measured numbers, not adjectives */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.3 }}
              className="mt-16 grid grid-cols-2 sm:grid-cols-4 gap-4"
            >
              {stats.map((s) => (
                <div
                  key={s.label}
                  className="bg-gray-800/40 border border-gray-700/40 rounded-2xl px-4 py-5"
                >
                  <div className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-primary-400 to-secondary-400 bg-clip-text text-transparent">
                    {s.value}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">{s.label}</div>
                </div>
              ))}
            </motion.div>
          </div>
        </div>
      </section>

      {/* Guarantees Section */}
      <section className="py-24 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              Guarantees, not features
            </h2>
            <p className="text-lg text-gray-400 max-w-2xl mx-auto">
              Every claim below is backed by a mechanism you can read and a test
              you can run — including killing a server while you type.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {guarantees.map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-2xl p-7 hover:border-gray-600/50 hover:bg-gray-800/80 transition-all duration-300 group"
              >
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-r ${feature.color} flex items-center justify-center mb-5 shadow-lg group-hover:scale-110 transition-transform`}
                >
                  <feature.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">{feature.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{feature.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 relative z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="bg-gradient-to-r from-primary-500/10 to-secondary-500/10 border border-primary-500/20 rounded-3xl p-10 sm:p-14 text-center"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              Your conversations. Your servers. Your keys.
            </h2>
            <p className="text-lg text-gray-400 mb-8 max-w-xl mx-auto">
              Create an account, enable encryption, and watch the delivery ticks
              do exactly what they promise.
            </p>
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Link
                to="/register"
                className="inline-flex items-center space-x-2 bg-white text-gray-900 hover:bg-gray-100 font-semibold py-3.5 px-8 rounded-xl transition-colors shadow-lg"
              >
                <span>Create Free Account</span>
                <ArrowRightIcon className="w-5 h-5" />
              </Link>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-10 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="flex items-center justify-center space-x-2 mb-3">
              <div className="w-8 h-8 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-lg flex items-center justify-center">
                <ChatBubbleLeftRightIcon className="w-5 h-5 text-white" />
              </div>
              <span className="text-lg font-bold text-white">CipherChat</span>
            </div>
            <p className="text-gray-500 text-sm">
              TypeScript · React · Socket.IO · MongoDB · Redis — 266 automated
              tests, RFC-vectored crypto, kill-a-pod verified
            </p>
            <p className="text-gray-600 text-xs mt-3">
              &copy; {new Date().getFullYear()} CipherChat · MIT licensed
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default IndexPage;
