import React from "react";
import axios from "axios";
import makeToast from "../Toaster";
import { useNavigate } from "react-router-dom";

const RegisterPage = (props) => {
  const nameRef = React.createRef();
  const emailRef = React.createRef();
  const passwordRef = React.createRef();

  const registerUser = (props) => {
    const name = nameRef.current.value;
    const email = emailRef.current.value;
    const password = passwordRef.current.value;

    axios
      .post("https://cipherchat-messenger.onrender.com/user/register", {
        name,
        email,
        password,
      })
      .then((response) => {
        makeToast("success", response.data.message);
        props.history.push("/login");
      })
      .catch((err) => {
        console.log(err);
        if (
          err &&
          err.response &&
          err.response.data &&
          err.response.data.message
        )
          makeToast("error", err.response.data.message);
      });
  };

  return (
    <div className="card">
      <div className="cardHeader">Registration</div>
      <div className="cardBody">
        <div className="inputGroup">
          <label htmlFor="name">Name</label>
          <input
            type="text"
            name="name"
            id="name"
            placeholder="Enter Your Name"
            ref={nameRef}
          />
        </div>
        <label htmlFor="email">Email</label>
        <input
          type="email"
          name="email"
          id="email"
          placeholder="abc@example.com"
          ref={emailRef}
        />
      </div>
      <div className="inputGroup">
        <label htmlFor="password">Password</label>
        <input
          type="password"
          name="password"
          id="password" 
          placeholder="Your Password"
          ref={passwordRef}
        />
      </div>
      <button onClick={registerUser}>Register</button>
      navigate("/login")
      {/* <Link to={"/login"}></Link> */}
    </div>
  );
};

export default RegisterPage;