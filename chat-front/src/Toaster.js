// This file is kept for backward compatibility
// The new Toaster component is in components/Toaster.js

const makeToast = (type, message) => {
  if (window.makeToast) {
    window.makeToast(type, message);
  } else {
    console.log(`${type}: ${message}`);
  }
};

export default makeToast;