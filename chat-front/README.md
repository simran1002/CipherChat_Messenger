# CipherChat - Modern Secure Messaging App

A beautiful, modern real-time messaging application built with React, featuring end-to-end encryption and a stunning user interface.

## ✨ Features

### 🎨 Modern UI/UX
- **Beautiful Design**: Clean, modern interface with smooth animations
- **Responsive Layout**: Works perfectly on desktop, tablet, and mobile
- **Dark/Light Theme Support**: Elegant color schemes
- **Smooth Animations**: Framer Motion powered transitions
- **Loading States**: Beautiful loading indicators and skeleton screens

### 💬 Chat Features
- **Real-time Messaging**: Instant message delivery with Socket.IO
- **Group Chatrooms**: Create and join multiple chatrooms
- **Typing Indicators**: See when others are typing
- **Message Timestamps**: Track when messages were sent
- **User Avatars**: Visual user identification
- **Auto-scroll**: Messages automatically scroll to bottom

### 🔐 Security
- **End-to-End Encryption**: Secure message transmission
- **JWT Authentication**: Secure user authentication
- **Protected Routes**: Automatic redirect for unauthorized access

### 🚀 Performance
- **Optimized Rendering**: Efficient React components
- **Lazy Loading**: Components load as needed
- **Smooth Scrolling**: Optimized chat experience

## 🛠️ Tech Stack

- **Frontend**: React 18, React Router v6
- **Styling**: Tailwind CSS, Custom CSS
- **Animations**: Framer Motion
- **Icons**: Heroicons
- **Real-time**: Socket.IO Client
- **HTTP Client**: Axios
- **Build Tool**: Create React App

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd chat-front
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm start
   ```

4. **Open your browser**
   Navigate to `http://localhost:3000`

## 🎯 Key Components

### Pages
- **IndexPage**: Beautiful landing page with features showcase
- **LoginPage**: Modern authentication with form validation
- **RegisterPage**: User registration with password confirmation
- **DashboardPage**: Chatroom management with search and filtering
- **ChatroomPage**: Real-time chat interface with message bubbles

### Components
- **Header**: Navigation bar with user menu and logout
- **Toaster**: Modern notification system with animations

### Styling
- **Tailwind CSS**: Utility-first CSS framework
- **Custom Components**: Reusable styled components
- **Animations**: Smooth transitions and micro-interactions

## 🎨 Design System

### Colors
- **Primary**: Blue gradient (#0ea5e9 to #0284c7)
- **Secondary**: Purple gradient (#d946ef to #c026d3)
- **Gray Scale**: Neutral colors for text and backgrounds

### Typography
- **Font**: Inter (Google Fonts)
- **Weights**: 300, 400, 500, 600, 700

### Components
- **Buttons**: Primary, Secondary, and Outline variants
- **Cards**: Elevated containers with hover effects
- **Inputs**: Styled form fields with focus states
- **Messages**: Bubble-style chat messages

## 🔧 Configuration

### Tailwind CSS
The project uses a custom Tailwind configuration with:
- Custom color palette
- Custom animations
- Responsive breakpoints
- Form styling plugin

### Environment Variables
Create a `.env` file in the root directory:
```env
REACT_APP_API_URL=https://cipherchat-messenger.onrender.com
```

## 📱 Responsive Design

The application is fully responsive with breakpoints:
- **Mobile**: < 640px
- **Tablet**: 640px - 1024px
- **Desktop**: > 1024px

## 🎭 Animations

### Page Transitions
- Fade-in animations on page load
- Slide-up effects for content
- Scale animations for interactive elements

### Micro-interactions
- Button hover effects
- Card hover animations
- Loading spinners
- Toast notifications

## 🔒 Security Features

- **JWT Token Management**: Secure token storage and validation
- **Protected Routes**: Automatic authentication checks
- **Input Validation**: Client-side form validation
- **XSS Protection**: Sanitized user inputs

## 🚀 Performance Optimizations

- **Code Splitting**: Lazy-loaded components
- **Memoization**: Optimized re-renders
- **Debounced Inputs**: Reduced API calls
- **Efficient State Management**: Minimal re-renders

## 📝 Available Scripts

- `npm start`: Start development server
- `npm build`: Build for production
- `npm test`: Run test suite
- `npm eject`: Eject from Create React App

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- **Heroicons** for beautiful icons
- **Framer Motion** for smooth animations
- **Tailwind CSS** for utility-first styling
- **Socket.IO** for real-time communication

---

Built with ❤️ using modern web technologies
