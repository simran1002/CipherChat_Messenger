import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChatBubbleLeftRightIcon,
  UserCircleIcon,
  ArrowRightOnRectangleIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  CameraIcon,
  SparklesIcon,
  HeartIcon,
  StarIcon
} from '@heroicons/react/24/outline';

function stringToColor(str) {
  // Simple hash to color
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00FFFFFF)
    .toString(16)
    .toUpperCase();
  return "#" + "00000".substring(0, 6 - c.length) + c;
}

const Header = ({ user, onLogout }) => {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = React.useState(false);

  const handleLogout = () => {
    localStorage.removeItem('CC_Token');
    if (onLogout) onLogout();
    navigate('/');
  };

  // Get user initials
  const getInitials = (nameOrEmail) => {
    if (!nameOrEmail) return '';
    const parts = nameOrEmail.split(' ');
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  };

  // Enhanced User avatar (DP)
  const renderAvatar = () => {
    if (user?.dpUrl) {
      return (
        <div className="relative">
          <img
            src={user.dpUrl}
            alt="Profile"
            className="w-10 h-10 rounded-xl object-cover border-3 border-gradient-to-r from-blue-400 to-purple-400 shadow-lg ring-2 ring-white/50"
          />
          <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full border-2 border-white shadow-sm"></div>
        </div>
      );
    }
    // Enhanced fallback: initials with beautiful gradient
    const initials = getInitials(user?.name || user?.email || 'U');
    const bgColor = stringToColor(user?.name || user?.email || 'U');
    return (
      <div className="relative">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-lg ring-2 ring-white/50 relative overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${bgColor} 0%, #8b5cf6 50%, #ec4899 100%)` }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent"></div>
          <span className="relative z-10">{initials}</span>
        </div>
        <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full border-2 border-white shadow-sm"></div>
      </div>
    );
  };

  return (
    <header className="bg-gradient-to-r from-white via-blue-50 to-purple-50 shadow-lg border-b border-blue-100 sticky top-0 z-40 backdrop-blur-sm dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 dark:border-gray-700 transition-colors duration-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-18">
          {/* Enhanced Logo - Responsive */}
          <Link to="/" className="flex items-center space-x-2 sm:space-x-3 group">
            <div className="relative">
              <div className="w-8 sm:w-10 h-8 sm:h-10 bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 rounded-xl flex items-center justify-center shadow-lg group-hover:shadow-xl transition-all duration-300 group-hover:scale-110">
                <SparklesIcon className="w-4 sm:w-6 h-4 sm:h-6 text-white animate-pulse" />
              </div>
              <div className="absolute -top-1 -right-1 w-3 sm:w-4 h-3 sm:h-4 bg-gradient-to-r from-yellow-400 to-orange-500 rounded-full flex items-center justify-center">
                <StarIcon className="w-1.5 sm:w-2 h-1.5 sm:h-2 text-white" />
              </div>
            </div>
            <div className="flex flex-col">
              <span className="text-lg sm:text-xl lg:text-2xl font-bold bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 bg-clip-text text-transparent group-hover:from-blue-700 group-hover:via-purple-700 group-hover:to-pink-700 transition-all duration-300">
                CipherChat
              </span>
              <span className="text-xs text-gray-500 font-medium -mt-1 hidden sm:block">Secure Messaging</span>
            </div>
          </Link>



          {/* Enhanced User Menu - Responsive */}
          <div className="flex items-center space-x-2 sm:space-x-4 relative">
            {user ? (
              <div className="flex items-center space-x-2 sm:space-x-3">
                {/* Standalone Logout Button - Always Visible */}
                <button
                  onClick={handleLogout}
                  className="hidden sm:flex items-center space-x-2 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-300 bg-gradient-to-r from-red-50 to-pink-50 hover:from-red-100 hover:to-pink-100 border border-red-200 hover:border-red-300 shadow-sm hover:shadow-md text-red-600 hover:text-red-700 group dark:from-red-900 dark:to-pink-900 dark:hover:from-red-800 dark:hover:to-pink-800 dark:border-red-700 dark:hover:border-red-600 dark:text-red-400 dark:hover:text-red-300"
                  title="Logout"
                >
                  <ArrowRightOnRectangleIcon className="w-4 h-4 group-hover:scale-110 transition-transform duration-300" />
                  <span className="hidden lg:inline">Logout</span>
                </button>
                
                {/* User Profile Button */}
                <button
                  className="flex items-center space-x-2 sm:space-x-3 focus:outline-none group bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 px-2 sm:px-4 py-2 rounded-xl border border-blue-100 hover:border-blue-200 shadow-sm hover:shadow-md transition-all duration-300"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <div className="relative">
                    {renderAvatar()}
                    <div className="absolute -bottom-1 -right-1 w-2.5 sm:w-3 h-2.5 sm:h-3 bg-green-400 border-2 border-white rounded-full animate-pulse"></div>
                  </div>
                  <span className="hidden md:block text-sm font-semibold text-gray-700 group-hover:text-blue-700 transition-colors duration-300">
                    {user.name || user.email}
                  </span>
                  <ChevronDownIcon className="w-3 sm:w-4 h-3 sm:h-4 text-gray-400 group-hover:text-blue-600 transition-colors duration-300" />
                </button>
                {/* Enhanced Dropdown menu */}
                {menuOpen && (
                  <div className="absolute right-0 mt-14 w-64 bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl border border-blue-100 z-50 animate-fade-in overflow-hidden">
                    <div className="p-6 border-b border-blue-100 flex flex-col items-center bg-gradient-to-br from-blue-50 to-purple-50">
                      <div className="relative">
                        {renderAvatar()}
                        <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-400 border-2 border-white rounded-full animate-pulse"></div>
                      </div>
                      <div className="mt-3 text-lg font-bold text-gray-900">
                        {user.name || user.email}
                      </div>
                      <div className="text-sm text-gray-600 flex items-center gap-1">
                        <HeartIcon className="w-4 h-4 text-pink-500" />
                        <span>Online</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {user.email}
                      </div>
                      <label className="mt-4 flex items-center gap-2 cursor-pointer text-blue-600 hover:text-blue-800 text-sm font-semibold bg-white px-4 py-2 rounded-lg shadow-sm hover:shadow-md transition-all duration-300 border border-blue-200">
                        <CameraIcon className="w-4 h-4" />
                        <span>Change Photo</span>
                        <input type="file" accept="image/*" className="hidden" disabled />
                      </label>
                    </div>
                    <div className="py-3">
                      <button
                        className="w-full flex items-center gap-3 px-6 py-3 text-sm text-gray-700 hover:bg-gradient-to-r hover:from-blue-50 hover:to-purple-50 rounded-xl transition-all duration-300 group"
                        disabled
                      >
                        <div className="p-2 bg-gray-100 rounded-lg group-hover:bg-blue-100 transition-colors duration-300">
                          <Cog6ToothIcon className="w-4 h-4 text-gray-600 group-hover:text-blue-600" />
                        </div>
                        <div className="text-left">
                          <div className="font-semibold">Profile Settings</div>
                          <div className="text-xs text-gray-500">Coming soon</div>
                        </div>
                      </button>
                      <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-3 px-6 py-3 text-sm text-red-600 hover:bg-gradient-to-r hover:from-red-50 hover:to-pink-50 rounded-xl transition-all duration-300 group mt-2"
                      >
                        <div className="p-2 bg-red-100 rounded-lg group-hover:bg-red-200 transition-colors duration-300">
                          <ArrowRightOnRectangleIcon className="w-4 h-4 text-red-600" />
                        </div>
                        <div className="text-left">
                          <div className="font-semibold">Logout</div>
                          <div className="text-xs text-red-500">Sign out of your account</div>
                        </div>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center space-x-2 sm:space-x-4">
                <Link
                  to="/login"
                  className="group relative px-3 sm:px-6 py-2 sm:py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 flex items-center space-x-2 bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 border border-blue-200 hover:border-blue-300 shadow-sm hover:shadow-md text-blue-700 hover:text-blue-800"
                >
                  <UserCircleIcon className="w-4 sm:w-5 h-4 sm:h-5" />
                  <span className="hidden sm:inline">Login</span>
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-400/10 to-purple-400/10 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                </Link>
                <Link
                  to="/register"
                  className="group relative px-3 sm:px-6 py-2 sm:py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 flex items-center space-x-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 shadow-lg hover:shadow-xl text-white transform hover:scale-105"
                >
                  <SparklesIcon className="w-4 sm:w-5 h-4 sm:h-5" />
                  <span className="hidden sm:inline">Sign Up</span>
                  <div className="absolute inset-0 bg-gradient-to-r from-white/10 to-white/20 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                </Link>
              </div>
            )}
          </div>
        </div>


      </div>
    </header>
  );
};

export default Header; 