import { useEffect, useState } from 'react';
import { api, type UserRecordDto } from '../app/api';

const ROLES = ['admin', 'architect', 'viewer'] as const;

/** Admin console: assign/change user roles and active status (FR-022). */
export function UsersPage() {
  const [users, setUsers] = useState<UserRecordDto[]>([]);

  const refresh = () => {
    api.listAdminUsers().then(({ users }) => setUsers(users));
  };

  useEffect(refresh, []);

  return (
    <div>
      {/* canvas-4pw: the page's <h1>, focused after an in-app navigation lands here. */}
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Users
      </h1>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} data-testid={`user-row-${user.id}`}>
              <td>{user.name}</td>
              <td>{user.email}</td>
              <td>
                <select
                  data-testid={`user-role-${user.id}`}
                  aria-label={`Role for ${user.name}`}
                  value={user.role}
                  onChange={(e) => api.updateAdminUser(user.id, { role: e.target.value }).then(refresh)}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  data-testid={`user-active-${user.id}`}
                  aria-label={`${user.name} is active`}
                  type="checkbox"
                  checked={user.active}
                  onChange={(e) => api.updateAdminUser(user.id, { active: e.target.checked }).then(refresh)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
