import React, { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useNotifications } from '../context/NotificationContext.jsx';
import api from '../api/client';
import { ROLE_LABELS, CAN_CREATE_CASE, CAN_MANAGE_USERS, ADMIN_ROLES, NGO_ROLES, MY_CASES_ROLES, ROLES } from '../roles.js';

export default function Layout() {
  const { user, logout } = useAuth();
  const { unreadCount } = useNotifications();
  const navigate = useNavigate();
  const [onDuty, setOnDuty] = useState(user.onDuty !== false);
  const [togglingDuty, setTogglingDuty] = useState(false);

  useEffect(() => { setOnDuty(user.onDuty !== false); }, [user.onDuty]);

  const canCreateCase = CAN_CREATE_CASE.includes(user.role);
  const canManageUsers = CAN_MANAGE_USERS.includes(user.role);
  const canViewDashboard = ADMIN_ROLES.includes(user.role);
  const canViewPlatformAdmin = [ROLES.SYSTEM_ADMIN, ROLES.SUPER_ADMIN].includes(user.role);
  const isNgoRole = NGO_ROLES.includes(user.role);
  const isCitizen = user.role === ROLES.CITIZEN;
  const isFamily = user.role === ROLES.FAMILY;
  // Family gets the fuller "My Missing Person" hub instead of the
  // bare list — My Cases stays for Citizen and official roles, who
  // still use it as a plain list.
  const canViewMyCases = MY_CASES_ROLES.includes(user.role) && !isFamily;
  const isPoliceAdmin = user.role === ROLES.POLICE_ADMIN;
  const canViewOfficerActivity = user.role === ROLES.DISTRICT_CONTROL;
  const manageUsersLabel = user.role === ROLES.NGO_ADMIN ? 'My Volunteers' : 'Manage Officials';
  const myCasesLabel = isCitizen ? 'My Cases' : 'Cases I Verified';

  const toggleDuty = async () => {
    setTogglingDuty(true);
    try {
      const { data } = await api.patch('/users/me/duty-status', { onDuty: !onDuty });
      setOnDuty(data.onDuty);
    } finally {
      setTogglingDuty(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="beacon" /> Rakshak</div>
        <div className="role-badge">{ROLE_LABELS[user.role]}</div>

        <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Cases &amp; Map</NavLink>
        {isPoliceAdmin && <NavLink to="/police-home" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>My Station</NavLink>}
        {isCitizen && <NavLink to="/search" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Search</NavLink>}
        {isCitizen && <NavLink to="/nearby-cases" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Nearby Cases</NavLink>}
        {canViewDashboard && <NavLink to="/dashboard" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Dashboard</NavLink>}
        {canCreateCase && <NavLink to="/cases/new" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Register Case (FIR)</NavLink>}
        {isFamily && <NavLink to="/emergency" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Emergency Report</NavLink>}
        {isFamily && <NavLink to="/my-missing-person" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>My Missing Person</NavLink>}
        {canViewMyCases && <NavLink to="/my-cases" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{myCasesLabel}</NavLink>}
        {isCitizen && <NavLink to="/my-reports" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>My Reports</NavLink>}
        {isNgoRole && <NavLink to="/my-assignments" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{user.role === ROLES.NGO_VOLUNTEER ? 'My Assignments' : 'Involved Cases'}</NavLink>}
        {canViewOfficerActivity && <NavLink to="/officer-activity" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Officer Activity</NavLink>}
        {canViewOfficerActivity && <NavLink to="/face-enrollment-review" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Face Enrollment Requests</NavLink>}
        {canViewOfficerActivity && <NavLink to="/face-enrollment-offline" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Face Enrollment (Offline)</NavLink>}
        {isPoliceAdmin && <NavLink to="/my-messages" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Messages</NavLink>}
        {isPoliceAdmin && (
          <NavLink to="/face-enrollment" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Face Enrollment</span>
            {user.faceEnrollment?.status !== 'enrolled' && (
              <span style={{ background: 'var(--accent)', color: '#1a1200', fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '1px 7px' }}>!</span>
            )}
          </NavLink>
        )}
        <NavLink to="/notifications" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Notifications</span>
          {unreadCount > 0 && (
            <span style={{ background: 'var(--accent)', color: '#1a1200', fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '1px 7px' }}>
              {unreadCount}
            </span>
          )}
        </NavLink>
        {isCitizen && <NavLink to="/safety-help" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Safety &amp; Help</NavLink>}
        {canManageUsers && <NavLink to="/admin/users" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>{manageUsersLabel}</NavLink>}
        {canViewPlatformAdmin && <NavLink to="/platform-admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>Platform Admin</NavLink>}

        <div style={{ marginTop: 'auto', paddingTop: 20 }}>
          {isPoliceAdmin && (
            <button
              className="btn btn-outline"
              style={{ width: '100%', marginBottom: 10, justifyContent: 'center' }}
              onClick={toggleDuty}
              disabled={togglingDuty}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: onDuty ? 'var(--success)' : 'var(--text-muted)', display: 'inline-block' }} />
              {onDuty ? 'On duty' : 'Off duty'} — tap to toggle
            </button>
          )}
          <p className="muted" style={{ marginBottom: 8 }}>{user.name}</p>
          <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => { logout(); navigate('/login'); }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
