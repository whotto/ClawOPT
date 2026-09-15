import { Navigate, useLocation } from 'react-router-dom';
import LoginScreen from '../../components/LoginScreen';
import { readLoginRedirectTarget, useAuth } from '../../app/auth';

export default function LoginPage() {
  const { isAuthenticated, markAuthenticated } = useAuth();
  const location = useLocation();

  if (isAuthenticated === true) {
    return <Navigate to={readLoginRedirectTarget(location.state)} replace />;
  }

  return <LoginScreen onLoginSuccess={markAuthenticated} />;
}
