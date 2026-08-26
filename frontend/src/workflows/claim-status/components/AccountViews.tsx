import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import type { AuthUser, ManagedUser } from "../shared/model";
type Setter<T> = Dispatch<SetStateAction<T>>;

export function ResetPasswordView(p: {
  mustResetPassword: boolean; password: string; confirmPassword: string;
  error: string; status: string; submitting: boolean;
  setPassword: Setter<string>; setConfirmPassword: Setter<string>;
  onSubmit: FormEventHandler<HTMLFormElement>; onBack: () => void;
}) {
  const { mustResetPassword, password: settingsPassword, confirmPassword: settingsConfirmPassword,
    error: settingsPasswordError, status: settingsPasswordStatus,
    submitting: settingsPasswordSubmitting, setPassword: setSettingsPassword,
    setConfirmPassword: setSettingsConfirmPassword, onSubmit: resetPasswordFromSettings } = p;
  const authUser = { mustResetPassword };
  const setActiveView = (_view: string) => p.onBack();
  const setSettingsOpen = (_open: boolean) => {};
  return <div className="mx-auto w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold">Reset Password</h1>
                {authUser.mustResetPassword && (
                  <p className="mt-1 text-sm text-slate-600">You need to reset your password before accessing the portal.</p>
                )}
              </div>
              {!authUser.mustResetPassword && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveView("portal-selection");
                    setSettingsOpen(false);
                  }}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
                >
                  Back
                </button>
              )}
            </div>

            <form className="mt-5 space-y-4" onSubmit={resetPasswordFromSettings}>
              <div>
                <label className="mb-2 block text-sm font-medium" htmlFor="settingsPassword">
                  Password
                </label>
                <input
                  id="settingsPassword"
                  type="password"
                  autoComplete="new-password"
                  value={settingsPassword}
                  onChange={(event) => setSettingsPassword(event.target.value)}
                  className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium" htmlFor="settingsConfirmPassword">
                  Confirm Password
                </label>
                <input
                  id="settingsConfirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={settingsConfirmPassword}
                  onChange={(event) => setSettingsConfirmPassword(event.target.value)}
                  className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </div>

              {settingsPasswordError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                  {settingsPasswordError}
                </div>
              )}

              {settingsPasswordStatus && (
                <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-700">
                  {settingsPasswordStatus}
                </div>
              )}

              <button
                type="submit"
                disabled={settingsPasswordSubmitting}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {settingsPasswordSubmitting ? "Please wait..." : "Update Password"}
              </button>
            </form>
          </div>;
}

export function ManageUsersView(p: {
  currentUserId: string; tab: "add" | "employees"; setTab: Setter<"add" | "employees">;
  error: string; status: string; newUserEmail: string; temporaryPassword: string;
  setNewUserEmail: Setter<string>; setTemporaryPassword: Setter<string>;
  users: ManagedUser[]; editingUserId: string; editingEmail: string;
  setEditingUserId: Setter<string>; setEditingEmail: Setter<string>;
  onAdd: FormEventHandler<HTMLFormElement>; onUpdateEmail: (id: string) => void;
  onDeactivate: (id: string) => void; onBack: () => void;
}) {
  const { tab: manageTab, setTab: setManageTab, error: manageError, status: manageStatus,
    newUserEmail, temporaryPassword, setNewUserEmail, setTemporaryPassword,
    users: managedUsers, editingUserId, editingEmail, setEditingUserId, setEditingEmail,
    onAdd: addManagedUser, onUpdateEmail: updateUserEmail, onDeactivate: deactivateUser } = p;
  const authUser = { userId: p.currentUserId } as AuthUser;
  const setActiveView = (_view: string) => p.onBack();
  return <div className="mx-auto w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h1 className="text-xl font-semibold">Manage Users</h1>
              <button
                type="button"
                onClick={() => {
                  setActiveView("portal-selection");
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
              >
                Back
              </button>
            </div>

            <div className="mt-5 flex gap-2 border-b border-slate-200">
              <button
                type="button"
                onClick={() => setManageTab("add")}
                className={`px-3 py-2 text-sm font-medium ${manageTab === "add" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-600"}`}
              >
                Add User
              </button>
              <button
                type="button"
                onClick={() => setManageTab("employees")}
                className={`px-3 py-2 text-sm font-medium ${manageTab === "employees" ? "border-b-2 border-blue-600 text-blue-700" : "text-slate-600"}`}
              >
                Manage Employees
              </button>
            </div>

            {manageError && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
                {manageError}
              </div>
            )}
            {manageStatus && (
              <div className="mt-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-700">
                {manageStatus}
              </div>
            )}

            {manageTab === "add" ? (
              <form className="mt-5 grid gap-4 md:grid-cols-[1fr_1fr_auto]" onSubmit={addManagedUser}>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="newUserEmail">
                    Email
                  </label>
                  <input
                    id="newUserEmail"
                    type="email"
                    value={newUserEmail}
                    onChange={(event) => setNewUserEmail(event.target.value)}
                    className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="temporaryPassword">
                    Temporary password
                  </label>
                  <input
                    id="temporaryPassword"
                    type="text"
                    value={temporaryPassword}
                    placeholder="Welcome123"
                    onChange={(event) => setTemporaryPassword(event.target.value)}
                    className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Add User
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="px-3 py-2 font-semibold">S.No.</th>
                      <th className="px-3 py-2 font-semibold">Employee name</th>
                      <th className="px-3 py-2 font-semibold">Role</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {managedUsers.map((user, index) => (
                      <tr key={user.userId} className="border-b border-slate-100">
                        <td className="px-3 py-3">{index + 1}</td>
                        <td className="px-3 py-3">
                          {editingUserId === user.userId ? (
                            <input
                              type="email"
                              value={editingEmail}
                              onChange={(event) => setEditingEmail(event.target.value)}
                              className="w-full rounded-md border border-slate-300 p-2 text-sm"
                            />
                          ) : (
                            user.email || user.username
                          )}
                        </td>
                        <td className="px-3 py-3">{user.role}</td>
                        <td className="px-3 py-3">{user.isActive ? "Active" : "Inactive"}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            {editingUserId === user.userId ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => updateUserEmail(user.userId)}
                                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingUserId("");
                                    setEditingEmail("");
                                  }}
                                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingUserId(user.userId);
                                  setEditingEmail(user.email || user.username);
                                }}
                                disabled={!user.isActive}
                                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:text-slate-400"
                              >
                                Edit Employee Email
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => deactivateUser(user.userId)}
                              disabled={!user.isActive || user.userId === authUser.userId}
                              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:cursor-not-allowed disabled:text-slate-400"
                            >
                              Deactivate
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>;
}
