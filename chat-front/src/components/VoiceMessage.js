import React, { useState, useRef, useEffect } from 'react';
import { 
  MicrophoneIcon, 
  StopIcon, 
  PlayIcon, 
  PauseIcon,
  TrashIcon,
  PaperAirplaneIcon
} from '@heroicons/react/24/outline';

const VoiceMessage = ({ onSend, onCancel, isRecording = false }) => {
  const [isRecordingState, setIsRecordingState] = useState(isRecording);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  
  const mediaRecorderRef = useRef(null);
  const audioRef = useRef(null);
  const recordingIntervalRef = useRef(null);
  const playbackIntervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (playbackIntervalRef.current) {
        clearInterval(playbackIntervalRef.current);
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      const chunks = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        chunks.push(event.data);
      };

      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        setAudioBlob(blob);
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorderRef.current.start();
      setIsRecordingState(true);
      setRecordingTime(0);

      // Start timer
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

    } catch (error) {
      console.error('Error accessing microphone:', error);
      alert('Unable to access microphone. Please check permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecordingState) {
      mediaRecorderRef.current.stop();
      setIsRecordingState(false);
      
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
    }
  };

  const handlePlayPause = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      if (playbackIntervalRef.current) {
        clearInterval(playbackIntervalRef.current);
      }
    } else {
      audioRef.current.play();
      setIsPlaying(true);
      
      playbackIntervalRef.current = setInterval(() => {
        if (audioRef.current) {
          setPlaybackTime(audioRef.current.currentTime);
        }
      }, 100);
    }
  };

  const handleAudioLoaded = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setPlaybackTime(0);
    if (playbackIntervalRef.current) {
      clearInterval(playbackIntervalRef.current);
    }
  };

  const handleSend = () => {
    if (audioBlob) {
      onSend(audioBlob);
    }
  };

  const handleCancel = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    setAudioBlob(null);
    setAudioUrl(null);
    setRecordingTime(0);
    setPlaybackTime(0);
    setDuration(0);
    setIsPlaying(false);
    onCancel();
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getProgressPercentage = () => {
    if (duration === 0) return 0;
    return (playbackTime / duration) * 100;
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-4">
      {!audioBlob ? (
        // Recording Interface
        <div className="space-y-4">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Voice Message
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {isRecordingState ? 'Recording...' : 'Tap to start recording'}
            </p>
          </div>

          <div className="flex items-center justify-center space-x-4">
            {!isRecordingState ? (
              <button
                onClick={startRecording}
                className="p-4 bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors duration-200 shadow-lg"
              >
                <MicrophoneIcon className="w-8 h-8" />
              </button>
            ) : (
              <div className="flex items-center space-x-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-500">
                    {formatTime(recordingTime)}
                  </div>
                  <div className="flex space-x-1 mt-2">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></div>
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></div>
                  </div>
                </div>
                <button
                  onClick={stopRecording}
                  className="p-4 bg-gray-500 hover:bg-gray-600 text-white rounded-full transition-colors duration-200"
                >
                  <StopIcon className="w-8 h-8" />
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        // Playback Interface
        <div className="space-y-4">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Voice Message Preview
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Duration: {formatTime(duration)}
            </p>
          </div>

          <div className="space-y-3">
            {/* Audio Player */}
            <audio
              ref={audioRef}
              src={audioUrl}
              onLoadedMetadata={handleAudioLoaded}
              onEnded={handleAudioEnded}
              className="hidden"
            />

            {/* Progress Bar */}
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-100"
                style={{ width: `${getProgressPercentage()}%` }}
              ></div>
            </div>

            {/* Time Display */}
            <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400">
              <span>{formatTime(playbackTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center space-x-4">
              <button
                onClick={handlePlayPause}
                className="p-3 bg-blue-500 hover:bg-blue-600 text-white rounded-full transition-colors duration-200"
              >
                {isPlaying ? (
                  <PauseIcon className="w-6 h-6" />
                ) : (
                  <PlayIcon className="w-6 h-6" />
                )}
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-center space-x-3">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 flex items-center space-x-2"
            >
              <TrashIcon className="w-4 h-4" />
              <span>Delete</span>
            </button>
            <button
              onClick={handleSend}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors duration-200 flex items-center space-x-2"
            >
              <PaperAirplaneIcon className="w-4 h-4" />
              <span>Send</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VoiceMessage; 