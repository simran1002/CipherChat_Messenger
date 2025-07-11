# Cipher Messenger

A modern, real-time chat application built with the MERN stack (MongoDB, Express.js, React.js, Node.js).

## Features

- 🔐 User authentication with profile pictures
- 💬 Real-time messaging
- 👥 User management and online status
- 🎨 Modern, responsive UI with animations
- 🌙 Theme switching capability
- 📱 Mobile-friendly design

## Quick Start

### Option 1: Start Both Frontend and Backend Together
```bash
npm start
```
This will start both the backend server and React frontend concurrently.

### Option 2: Start Separately

**Backend (Terminal 1):**
```bash
cd chat-back
npm start
```

**Frontend (Terminal 2):**
```bash
cd chat-front
npm start
```

## Installation

If you haven't installed dependencies yet:
```bash
npm run install-all
```

This will install dependencies for the root project, backend, and frontend.

## Available Scripts

- `npm start` - Start both frontend and backend
- `npm run server` - Start only the backend
- `npm run client` - Start only the frontend
- `npm run dev` - Alternative command to start both (same as npm start)
- `npm run install-all` - Install all dependencies

## Tech Stack

- **Frontend:** React.js, Tailwind CSS, Framer Motion, Heroicons
- **Backend:** Node.js, Express.js, Socket.io
- **Database:** MongoDB
- **Authentication:** JWT

## Project Structure

```
Cipher_Messenger/
├── chat-back/          # Backend server
├── chat-front/         # React frontend
├── package.json        # Root package.json for easy startup
└── README.md
```

## Default Ports

- Frontend: http://localhost:3000
- Backend: http://localhost:5000

## Environment Variables

Make sure your backend has the necessary environment variables set up in `chat-back/.env`:
- `MONGODB_URI`
- `JWT_SECRET`
- `PORT` (optional, defaults to 5000)
