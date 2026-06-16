import React, { useState, useRef, useEffect } from "react";
import { MicrophoneIcon, StopIcon, TrashIcon, PaperAirplaneIcon } from "@heroicons/react/24/solid";

const VoiceRecorder = ({ onSend, onCancel }) => {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  useEffect(() => {
    startRecording();
    return () => {
      stopTimer();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []); // eslint-disable-line

  const startTimer = () => {
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  };

  const stopTimer = () => {
    clearInterval(timerRef.current);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => chunksRef.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      startTimer();
    } catch {
      onCancel();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
    setRecording(false);
    stopTimer();
  };

  const handleSend = () => {
    if (audioBlob) onSend(audioBlob);
  };

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-gray-800 rounded-2xl w-full">
      {recording ? (
        <>
          <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
          <span className="text-red-400 font-mono text-sm flex-1">{fmt(seconds)}</span>
          <button onClick={stopRecording} className="p-2 bg-red-600 hover:bg-red-700 rounded-full transition-colors">
            <StopIcon className="w-4 h-4 text-white" />
          </button>
        </>
      ) : audioUrl ? (
        <>
          <audio src={audioUrl} controls className="flex-1 h-8 max-w-xs" />
          <span className="text-gray-400 text-xs">{fmt(seconds)}</span>
          <button onClick={onCancel} className="p-2 bg-gray-700 hover:bg-gray-600 rounded-full">
            <TrashIcon className="w-4 h-4 text-red-400" />
          </button>
          <button onClick={handleSend} className="p-2 bg-violet-600 hover:bg-violet-500 rounded-full">
            <PaperAirplaneIcon className="w-4 h-4 text-white" />
          </button>
        </>
      ) : null}
      {!recording && !audioUrl && (
        <button onClick={startRecording} className="p-2 bg-violet-600 rounded-full">
          <MicrophoneIcon className="w-4 h-4 text-white" />
        </button>
      )}
    </div>
  );
};

export default VoiceRecorder;
