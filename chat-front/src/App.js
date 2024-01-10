import React from "react";
// import { BrowserRouter as Router, Route } from 'react-router-dom';
import { BrowserRouter as Router, Route,Routes} from 'react-router-dom'; // Switch is not needed, use Routes
import LoginPage from "./Pages/LoginPage";
import RegisterPage from "./Pages/RegisterPage";
import DashboardPage from "./Pages/DashboardPage";
import IndexPage from "./Pages/IndexPage";
import ChatroomPage from "./Pages/ChatroomPage";
import io from "socket.io-client";
import makeToast from "./Toaster";

function App() {
  const [socket, setSocket] = React.useState(null);

  const setupSocket = () => {
    const token = localStorage.getItem("CC_Token");
    if (token && !socket) {
      const newSocket = io("https://cipherchat-messenger.onrender.com", {
        query: {
          token: localStorage.getItem("CC_Token"),
        },
      });

      newSocket.on("disconnect", () => {
        setSocket(null);
        setTimeout(setupSocket, 3000);
        makeToast("error", "Socket Disconnected!");
      });

      newSocket.on("connect", () => {
        makeToast("success", "Socket Connected!");
      });

      setSocket(newSocket);
    }
  };

  React.useEffect(() => {
    setupSocket();
    //eslint-disable-next-line
  }, []);

  // return (
  //   <Router>
  //     <Switch>
  //       <Route path="/" component={IndexPage} exact />
  //       <Route
  //         path="/login"
  //         render={() => <LoginPage setupSocket={setupSocket} />}
  //         exact
  //       />
  //       <Route path="/register" component={RegisterPage} exact />
  //       <Route
  //         path="/dashboard"
  //         render={() => <DashboardPage socket={socket} />}
  //         exact
  //       />
  //       <Route
  //         path="/chatroom/:id"
  //         render={() => <ChatroomPage socket={socket} />}
  //         exact
  //       />
  //     </Switch>
  //   </Router>
  // );



  return (
    <Router>
      <Routes>
        <Route path="/" element={<IndexPage />} />
        <Route
          path="/login"
          element={<LoginPage setupSocket={setupSocket} />}
        />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/dashboard"
          element={<DashboardPage socket={socket} />}
        />
        <Route
          path="/chatroom/:id"
          element={<ChatroomPage socket={socket} />}
        />
      </Routes>
    </Router>
  );
}

export default App;