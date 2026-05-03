import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  CalendarDays,
  UtensilsCrossed,
  Ban,
  Settings,
} from "lucide-react";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/meal-plan", label: "Meal Plan", icon: CalendarDays },
  { to: "/log-meal", label: "Log Meal", icon: UtensilsCrossed },
  { to: "/meals-to-avoid", label: "Meals to Avoid", icon: Ban },
  { to: "/profile", label: "Profile Settings", icon: Settings },
];

type SidebarProps = {
  isMobileOpen?: boolean;
  onNavigate?: () => void;
};

export default function Sidebar({
  isMobileOpen = false,
  onNavigate,
}: SidebarProps) {
  const navContent = (
    <nav className="space-y-1 px-3 py-4">
      {navItems.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
              isActive
                ? "bg-white text-[#176b9f] shadow-sm"
                : "text-sky-50/85 hover:bg-white/10 hover:text-white"
            }`
          }
        >
          <Icon className="h-4.5 w-4.5" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );

  return (
    <>
      <aside className="hidden h-full w-64 shrink-0 border-r border-slate-900/10 bg-[#174c72] text-white shadow-xl lg:block">
        {navContent}
      </aside>

      <div
        className={`fixed inset-0 z-40 bg-slate-950/45 transition lg:hidden ${
          isMobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        onClick={onNavigate}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[17rem] max-w-[82vw] bg-[#174c72] text-white shadow-2xl transition-transform duration-200 lg:hidden ${
          isMobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-white/10 px-4 py-4">
          <p className="text-lg font-semibold text-white">MealCare</p>
        </div>
        {navContent}
      </aside>
    </>
  );
}
