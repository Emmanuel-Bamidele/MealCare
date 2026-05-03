import { useEffect, useState } from "react";
import { ClipboardList, Link2, Plus, Trash2, X } from "lucide-react";
import MealHistoryList from "../components/MealHistoryList";
import MealLogComposer from "../components/MealLogComposer";
import {
  CaloriesTrendPanel,
  MacroTrendPanel,
} from "../components/NutritionTrendPanels";
import api from "../lib/api";
import {
  buildMealDescription,
  calculateMacroPercentages,
  createEmptySummary,
  deleteMealLog,
  fetchDailySummary,
  fetchMealLogs,
  fetchNutritionProgress,
  formatDateLabel,
  formatMealTypeLabel,
  groupByMealType,
  MEAL_TYPES,
  roundValue,
  toLocalDateKey,
  type DailyNutritionSummary,
  type MealLog,
  type MealType,
  type NutritionProgressSummary,
} from "../lib/meal-log";

type UtilityTab = "log" | "history";
type SummaryView = "today" | "trends";

type UserData = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fhirPatientId: string | null;
  weightLbs: number | null;
  heightIn: number | null;
  calorieGoal: number;
};

type HumanName = {
  given?: string[];
  family?: string;
};

type Patient = {
  id: string;
  name?: HumanName[];
  birthDate?: string;
  gender?: string;
};

type FhirContext = {
  patient: Patient | null;
  conditions: string[];
  allergies: string[];
  providerSuggestions: string[];
};

type PlannedMealFood = {
  id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type PlannedMealItem = {
  id: string;
  servings: number;
  food: PlannedMealFood;
};

type PlannedMealSlot = {
  items: PlannedMealItem[];
  totals: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
};

type SavedMealPlanDay = {
  day: string;
  dayOfWeek: number;
  meals: Record<Lowercase<MealType>, PlannedMealSlot>;
};

type SavedMealPlan = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  days: SavedMealPlanDay[];
};

type CurrentMealPlanResponse = {
  plan: SavedMealPlan | null;
};

type PatientSearchEntry = {
  resource: {
    id: string;
    name?: HumanName[];
  };
};

function createEmptyFhirContext(): FhirContext {
  return {
    patient: null,
    conditions: [],
    allergies: [],
    providerSuggestions: [
      "Link a FHIR patient to unlock condition-aware meal guidance and allergy reminders.",
    ],
  };
}

function formatPatientName(
  patient: Patient | null,
  user: UserData | null,
): string {
  const name = patient?.name?.[0];
  const givenName = name?.given?.join(" ") || name?.given?.[0] || "";
  const familyName = name?.family || "";
  const combined = `${givenName} ${familyName}`.trim();

  if (combined) {
    return combined;
  }

  if (user) {
    return `${user.firstName} ${user.lastName}`.trim();
  }

  return "No linked patient";
}

function formatValueList(values: string[], emptyValue: string): string {
  return values.length > 0 ? values.join(", ") : emptyValue;
}

function buildPlannedMealDescription(slot: PlannedMealSlot | undefined): string {
  const names = slot?.items.map((item) => item.food.name) ?? [];

  if (names.length === 0) {
    return "No planned meal saved";
  }

  if (names.length <= 3) {
    return names.join(", ");
  }

  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

function getPlanDayForDate(
  plan: SavedMealPlan | null,
  selectedDate: string,
): SavedMealPlanDay | null {
  if (!plan) return null;

  const start = new Date(`${plan.startDate.slice(0, 10)}T00:00:00`);
  const selected = new Date(`${selectedDate}T00:00:00`);
  const diffDays = Math.round(
    (selected.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
  );

  return plan.days.find((day) => day.dayOfWeek === diffDays) ?? null;
}

export default function Dashboard() {
  const [user, setUser] = useState<UserData | null>(null);
  const [mealLogs, setMealLogs] = useState<MealLog[]>([]);
  const [currentMealPlan, setCurrentMealPlan] = useState<SavedMealPlan | null>(
    null,
  );
  const [dailySummary, setDailySummary] = useState<DailyNutritionSummary>(() =>
    createEmptySummary(toLocalDateKey(new Date())),
  );
  const [fhirContext, setFhirContext] = useState<FhirContext>(() =>
    createEmptyFhirContext(),
  );

  const [selectedDate, setSelectedDate] = useState(() =>
    toLocalDateKey(new Date()),
  );
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [patientResults, setPatientResults] = useState<PatientSearchEntry[]>(
    [],
  );
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [patientLoadError, setPatientLoadError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(true);
  const [removingPlanSlot, setRemovingPlanSlot] = useState<string | null>(null);
  const [summaryView, setSummaryView] = useState<SummaryView>("today");
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const [progressSummary, setProgressSummary] =
    useState<NutritionProgressSummary | null>(null);
  const [isLoadingProgress, setIsLoadingProgress] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [isUtilityPanelOpen, setIsUtilityPanelOpen] = useState(false);
  const [utilityTab, setUtilityTab] = useState<UtilityTab>("log");
  const [macroView, setMacroView] = useState<"goals" | "breakdown">("goals");

  const calorieGoal = user?.calorieGoal || 2000;
  useEffect(() => {
    let cancelled = false;

    const loadInitialContext = async () => {
      try {
        const [userResponse, contextResponse] = await Promise.all([
          api.get<UserData>("/me"),
          api.get<FhirContext>("/fhir/context"),
        ]);

        if (!cancelled) {
          setUser(userResponse.data);
          setFhirContext(contextResponse.data);
        }
      } catch {
        if (!cancelled) {
          setDashboardError("Unable to load your profile.");
        }
      }
    };

    void loadInitialContext();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadDashboard = async () => {
      setIsLoadingDashboard(true);
      setDashboardError(null);

      try {
        const [logs, summary, planResponse] = await Promise.all([
          fetchMealLogs(selectedDate),
          fetchDailySummary(selectedDate),
          api.get<CurrentMealPlanResponse>("/meal-plan/current", {
            params: { date: selectedDate },
          }),
        ]);

        if (!cancelled) {
          setMealLogs(logs);
          setDailySummary(summary);
          setCurrentMealPlan(planResponse.data.plan);
        }
      } catch {
        if (!cancelled) {
          setMealLogs([]);
          setCurrentMealPlan(null);
          setDailySummary(createEmptySummary(selectedDate));
          setDashboardError("Unable to load nutrition data right now.");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDashboard(false);
        }
      }
    };

    void loadDashboard();

    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  useEffect(() => {
    let cancelled = false;

    if (summaryView !== "trends") {
      return () => {
        cancelled = true;
      };
    }

    const loadProgress = async () => {
      setIsLoadingProgress(true);
      setProgressError(null);

      try {
        const progress = await fetchNutritionProgress(selectedDate, trendDays);

        if (!cancelled) {
          setProgressSummary(progress);
        }
      } catch {
        if (!cancelled) {
          setProgressSummary(null);
          setProgressError("Unable to load nutrition trends right now.");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingProgress(false);
        }
      }
    };

    void loadProgress();

    return () => {
      cancelled = true;
    };
  }, [selectedDate, summaryView, trendDays]);

  const reloadSelectedDate = async () => {
    const [logs, summary, planResponse] = await Promise.all([
      fetchMealLogs(selectedDate),
      fetchDailySummary(selectedDate),
      api.get<CurrentMealPlanResponse>("/meal-plan/current", {
        params: { date: selectedDate },
      }),
    ]);

    setMealLogs(logs);
    setDailySummary(summary);
    setCurrentMealPlan(planResponse.data.plan);
  };

  // const reloadFhirContext = async () => {
  //   const response = await api.get<FhirContext>("/fhir/context");
  //   setFhirContext(response.data);
  // };

  const loadPatients = async () => {
    setIsLoadingPatients(true);
    setPatientLoadError(null);

    try {
      const response = await api.get<PatientSearchEntry[]>("/fhir/patients");
      setPatientResults(response.data);
    } catch {
      setPatientResults([]);
      setPatientLoadError(
        "Unable to load FHIR patients. Make sure the backend and FHIR server are running.",
      );
    } finally {
      setIsLoadingPatients(false);
    }
  };

  const linkPatient = async (id: string) => {
    await api.post("/fhir/link", { fhirPatientId: id });
    const [userRes, contextRes] = await Promise.all([
      api.get<UserData>("/me"),
      api.get<FhirContext>("/fhir/context"),
    ]);
    setUser(userRes.data);
    setFhirContext(contextRes.data);
    setShowLinkModal(false);
    setPatientResults([]);
  };

  const deleteMeal = async (id: string) => {
    await deleteMealLog(id);
    await reloadSelectedDate();
  };

  const removePlannedMeal = async (mealType: MealType) => {
    const slotKey = `${selectedDate}-${mealType}`;
    setRemovingPlanSlot(slotKey);
    setPlanError(null);

    try {
      await api.delete("/meal-plan/items", {
        params: { date: selectedDate, mealType },
      });
      await reloadSelectedDate();
    } catch {
      setPlanError("Unable to remove that planned meal right now.");
    } finally {
      setRemovingPlanSlot(null);
    }
  };

  const openUtilityPanel = (tab: UtilityTab) => {
    setUtilityTab(tab);
    setIsUtilityPanelOpen(true);
  };

  const groupedMeals = groupByMealType(mealLogs);
  const selectedPlanDay = getPlanDayForDate(currentMealPlan, selectedDate);
  const macroPercentages = calculateMacroPercentages(dailySummary.totals);
  const calorieProgress = Math.min(
    100,
    Math.round((dailySummary.totals.calories / calorieGoal) * 100),
  );
  const patientName = formatPatientName(fhirContext.patient, user);
  const trendBuckets = progressSummary?.buckets ?? [];

  if (!user) {
    return (
      <div className="h-full flex items-center justify-center bg-[radial-gradient(circle_at_top,#f9fcff_0%,#eef5fb_55%,#e7eff8_100%)]">
        <p className="text-slate-500">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="premium-page">
      <div className="premium-shell">
        <div className="grid gap-3 xl:grid-cols-[0.82fr,1.38fr]">
          <section className="premium-panel">
            <h2 className="premium-section-title">
              Your Information
            </h2>
            <div className="mt-4 space-y-2.5 text-sm text-slate-700">
              <p>
                <span className="font-semibold text-slate-800">Name:</span>{" "}
                {patientName}
              </p>
              <p>
                <span className="font-semibold text-slate-800">Email:</span>{" "}
                {user?.email || "Unavailable"}
              </p>
              <p>
                <span className="font-semibold text-slate-800">
                  Conditions:
                </span>{" "}
                {formatValueList(
                  fhirContext.conditions,
                  "No linked conditions found",
                )}
              </p>
              <p>
                <span className="font-semibold text-slate-800">Allergies:</span>{" "}
                <span className="text-rose-500">
                  {formatValueList(
                    fhirContext.allergies,
                    "No known allergies found",
                  )}
                </span>
              </p>
            </div>
            {(!user?.weightLbs || !user?.heightIn) && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold text-amber-800 mb-2">
                  Enter your measurements for personalized calorie goals
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.target as HTMLFormElement;
                    const weight = parseFloat(
                      (form.elements.namedItem("weight") as HTMLInputElement)
                        .value,
                    );
                    const feet = parseFloat(
                      (form.elements.namedItem("feet") as HTMLInputElement)
                        .value,
                    );
                    const inches = parseFloat(
                      (form.elements.namedItem("inches") as HTMLInputElement)
                        .value || "0",
                    );

                    if (weight < 50 || weight > 700) {
                      setDashboardError(
                        "Weight must be between 50 and 700 lbs.",
                      );
                      return;
                    }
                    if (feet < 3 || feet > 8) {
                      setDashboardError("Height must be between 3 and 8 feet.");
                      return;
                    }
                    if (inches < 0 || inches > 11) {
                      setDashboardError("Inches must be between 0 and 11.");
                      return;
                    }

                    setDashboardError(null);
                    await api.put("/auth/profile", {
                      weightLbs: weight,
                      heightIn: feet * 12 + inches,
                    });
                    const res = await api.get<UserData>("/me");
                    setUser(res.data);
                  }}
                >
                  <div className="flex gap-2">
                    <input
                      type="number"
                      name="weight"
                      placeholder="Weight (lbs)"
                      required
                      className="premium-input w-full"
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (num < 0 || num > 700) {
                          e.target.value = e.target.value.slice(0, -1);
                        }
                      }}
                    />
                    <input
                      type="number"
                      name="feet"
                      placeholder="Feet"
                      required
                      className="premium-input w-24"
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (num < 0 || num > 8) {
                          e.target.value = e.target.value.slice(0, -1);
                        }
                      }}
                    />
                    <input
                      type="number"
                      name="inches"
                      placeholder="In"
                      className="premium-input w-20"
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (num < 0 || num > 11) {
                          e.target.value = e.target.value.slice(0, -1);
                        }
                      }}
                    />
                  </div>
                  {dashboardError && (
                    <p className="mt-2 text-xs text-red-500">
                      {dashboardError}
                    </p>
                  )}
                  <button
                    type="submit"
                    className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700"
                  >
                    Save Measurements
                  </button>
                </form>
              </div>
            )}

            {user?.weightLbs && user?.heightIn && (
              <div className="mt-4 space-y-2.5 text-sm text-slate-700">
                <p>
                  <span className="font-semibold text-slate-800">Weight:</span>{" "}
                  {user.weightLbs} lbs
                </p>
                <p>
                  <span className="font-semibold text-slate-800">Height:</span>{" "}
                  {Math.floor(user.heightIn / 12)}'
                  {Math.round(user.heightIn % 12)}"
                </p>
                {fhirContext.patient?.gender && (
                  <p>
                    <span className="font-semibold text-slate-800">Sex:</span>{" "}
                    <span className="capitalize">
                      {fhirContext.patient.gender}
                    </span>
                  </p>
                )}
                {fhirContext.patient?.birthDate && (
                  <p>
                    <span className="font-semibold text-slate-800">DOB:</span>{" "}
                    {fhirContext.patient.birthDate}
                  </p>
                )}
                <p>
                  <span className="font-semibold text-slate-800">
                    Daily Calorie Goal:
                  </span>{" "}
                  {calorieGoal} kcal
                </p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={async () => {
                  setShowLinkModal(true);
                  await loadPatients();
                }}
                className="premium-button-secondary px-3 py-2 text-xs"
                type="button"
              >
                <Link2 className="h-4 w-4" />
                {fhirContext.patient
                  ? "Relink Patient Data"
                  : "Link Your FHIR Patient Data"}
              </button>
            </div>
          </section>

          <section className="premium-panel">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="premium-section-title">
                    Today&apos;s Summary
                  </h2>
                  <div className="inline-flex rounded-full bg-sky-100 p-1 text-xs font-medium text-slate-600">
                    {[
                      { id: "today", label: "Today" },
                      { id: "trends", label: "Trends" },
                    ].map((item) => (
                      <button
                        key={item.id}
                        onClick={() => setSummaryView(item.id as SummaryView)}
                        className={`rounded-full px-3 py-1 transition ${
                          summaryView === item.id
                            ? "bg-white text-[#205278] shadow-sm"
                            : "text-slate-500"
                        }`}
                        type="button"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <p className="text-sm text-slate-500">
                    {formatDateLabel(selectedDate)}
                  </p>
                  {summaryView === "trends" && (
                    <div className="inline-flex rounded-full bg-white/80 p-1 text-[11px] font-medium text-slate-600 shadow-sm">
                      {[7, 30].map((days) => (
                        <button
                          key={days}
                          onClick={() => setTrendDays(days as 7 | 30)}
                          className={`rounded-full px-2.5 py-1 transition ${
                            trendDays === days
                              ? "bg-[#1e86c8] text-white"
                              : "text-slate-500"
                          }`}
                          type="button"
                        >
                          {days}D
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center xl:flex-nowrap">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="premium-input"
                />
                <button
                  onClick={() => openUtilityPanel("log")}
                  className="premium-button-primary whitespace-nowrap px-3 py-2 text-xs"
                  type="button"
                >
                  <Plus className="h-4 w-4" />
                  Quick Log
                </button>
                <button
                  onClick={() => openUtilityPanel("history")}
                  className="premium-button-secondary whitespace-nowrap px-3 py-2 text-xs"
                  type="button"
                >
                  <ClipboardList className="h-4 w-4" />
                  View History
                </button>
              </div>
            </div>

            {summaryView === "today" ? (
              <>
                <div className="mt-4">
                  <div className="flex items-center justify-between text-sm font-semibold text-slate-800">
                    <span>Calories</span>
                    <span>
                      {roundValue(dailySummary.totals.calories)} / {calorieGoal}{" "}
                      kcal{" "}
                    </span>
                  </div>
                  <div className="mt-2.5 h-3 rounded-full bg-sky-100">
                    <div
                      className="h-3 rounded-full bg-gradient-to-r from-emerald-400 to-[#1fba8c] transition-all"
                      style={{ width: `${calorieProgress}%` }}
                    />
                  </div>
                </div>

                <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
                  {[
                    {
                      label: "Protein",
                      value: `${roundValue(dailySummary.totals.protein)} g`,
                      accent: "text-emerald-600",
                    },
                    {
                      label: "Carbs",
                      value: `${roundValue(dailySummary.totals.carbs)} g`,
                      accent: "text-[#1e7cb6]",
                    },
                    {
                      label: "Fat",
                      value: `${roundValue(dailySummary.totals.fat)} g`,
                      accent: "text-amber-500",
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-lg border border-white/60 bg-white/80 px-3 py-2.5 shadow-sm"
                    >
                      <p className="text-xs text-slate-500">{item.label}</p>
                      <p
                        className={`mt-1 text-lg font-semibold ${item.accent}`}
                      >
                        {item.value}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-3 text-xs text-slate-500">
                  {isLoadingDashboard
                    ? "Refreshing nutrition data..."
                    : `${dailySummary.mealCount} meals logged across ${dailySummary.itemCount} food items.`}
                </div>
              </>
            ) : (
              <>
                {progressError && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {progressError}
                  </div>
                )}
                {isLoadingProgress ? (
                  <div className="mt-4 rounded-xl border border-white/70 bg-white/80 px-4 py-8 text-sm text-slate-500 shadow-sm">
                    Loading nutrition trends...
                  </div>
                ) : trendBuckets.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-white/70 bg-white/80 px-4 py-8 text-sm text-slate-500 shadow-sm">
                    Trend data is unavailable for this view.
                  </div>
                ) : (
                  <CaloriesTrendPanel buckets={trendBuckets} days={trendDays} />
                )}
              </>
            )}
          </section>
        </div>

        <section className="premium-panel mt-3">
          <h2 className="premium-section-title">
            Today&apos;s Meals
          </h2>
          <div className="mt-4 space-y-2.5 md:hidden">
            {MEAL_TYPES.map((currentMealType) => (
              <div
                key={currentMealType}
              className="rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#204f74]">
                      {formatMealTypeLabel(currentMealType)}
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {buildMealDescription(groupedMeals[currentMealType])}
                    </p>
                  </div>
                  <p className="whitespace-nowrap text-sm font-semibold text-emerald-500">
                    {roundValue(
                      dailySummary.byMealType[currentMealType].calories,
                    )}{" "}
                    kcal
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 hidden overflow-x-auto rounded-lg border border-slate-200 md:block">
            <table className="premium-table min-w-[38rem]">
              <thead>
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Meals</th>
                  <th className="px-4 py-2.5 font-semibold">Description</th>
                  <th className="px-4 py-2.5 text-right font-semibold">
                    Calories
                  </th>
                </tr>
              </thead>
              <tbody>
                {MEAL_TYPES.map((currentMealType) => (
                  <tr
                    key={currentMealType}
                    className="odd:bg-white even:bg-slate-50/50"
                  >
                    <td className="px-4 py-3 font-semibold text-[#204f74]">
                      {formatMealTypeLabel(currentMealType)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {buildMealDescription(groupedMeals[currentMealType])}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-emerald-500">
                      {roundValue(
                        dailySummary.byMealType[currentMealType].calories,
                      )}{" "}
                      kcal
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="premium-panel mt-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="premium-section-title">
                Planned Meals
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Saved plan items for {formatDateLabel(selectedDate)}
              </p>
            </div>
            {currentMealPlan && (
              <p className="text-xs font-medium text-emerald-600">
                {currentMealPlan.name}
              </p>
            )}
          </div>

          <div className="mt-4 space-y-2.5 md:hidden">
            {MEAL_TYPES.map((currentMealType) => {
              const slot =
                selectedPlanDay?.meals[
                  currentMealType.toLowerCase() as Lowercase<MealType>
                ];
              const hasPlannedItems = Boolean(slot?.items.length);
              const isRemoving =
                removingPlanSlot === `${selectedDate}-${currentMealType}`;

              return (
                <div
                  key={currentMealType}
                  className="rounded-lg border border-emerald-100 bg-emerald-50/40 px-3.5 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-emerald-700">
                        {formatMealTypeLabel(currentMealType)}
                      </p>
                      <p className="mt-1 text-sm text-slate-700">
                        {buildPlannedMealDescription(slot)}
                      </p>
                    </div>
                    <p className="whitespace-nowrap text-sm font-semibold text-emerald-500">
                      {roundValue(slot?.totals.calories ?? 0)} kcal
                    </p>
                  </div>
                  {hasPlannedItems && (
                    <button
                      type="button"
                      onClick={() => removePlannedMeal(currentMealType)}
                      disabled={isRemoving}
                      className="premium-button-danger mt-3"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {isRemoving ? "Removing..." : "Remove"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {planError && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {planError}
            </div>
          )}

          <div className="mt-4 hidden overflow-x-auto rounded-lg border border-slate-200 md:block">
            <table className="premium-table min-w-[42rem]">
              <thead>
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Meal</th>
                  <th className="px-4 py-2.5 font-semibold">Planned Items</th>
                  <th className="px-4 py-2.5 text-right font-semibold">
                    Calories
                  </th>
                  <th className="px-4 py-2.5 text-right font-semibold">
                    Macros
                  </th>
                  <th className="px-4 py-2.5 text-right font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {MEAL_TYPES.map((currentMealType) => {
                  const slot =
                    selectedPlanDay?.meals[
                      currentMealType.toLowerCase() as Lowercase<MealType>
                    ];
                  const hasPlannedItems = Boolean(slot?.items.length);
                  const isRemoving =
                    removingPlanSlot === `${selectedDate}-${currentMealType}`;

                  return (
                    <tr
                      key={currentMealType}
                      className="odd:bg-white even:bg-slate-50/50"
                    >
                      <td className="px-4 py-3 font-semibold text-emerald-700">
                        {formatMealTypeLabel(currentMealType)}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {buildPlannedMealDescription(slot)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-emerald-500">
                        {roundValue(slot?.totals.calories ?? 0)} kcal
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-slate-500">
                        P {roundValue(slot?.totals.protein ?? 0)}g / C{" "}
                        {roundValue(slot?.totals.carbs ?? 0)}g / F{" "}
                        {roundValue(slot?.totals.fat ?? 0)}g
                      </td>
                      <td className="px-4 py-3 text-right">
                        {hasPlannedItems && (
                          <button
                            type="button"
                            onClick={() => removePlannedMeal(currentMealType)}
                            disabled={isRemoving}
                            className="premium-button-danger"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {isRemoving ? "Removing..." : "Remove"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="mt-3 grid gap-3 xl:grid-cols-[1fr,0.95fr]">
          <section className="premium-panel">
            <div className="flex items-center justify-between">
              <h2 className="premium-section-title">
                {summaryView !== "today"
                  ? "Macronutrient Trends"
                  : macroView === "goals"
                    ? "Daily Macronutrient Goals"
                    : "Daily Macronutrient Breakdown"}
              </h2>
              {summaryView === "today" && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setMacroView("goals")}
                    className={`rounded-lg px-2 py-1 text-xs font-medium transition ${
                      macroView === "goals"
                        ? "bg-sky-100 text-[#205278]"
                        : "text-slate-400 hover:text-slate-600"
                    }`}
                    type="button"
                  >
                    Goals
                  </button>
                  <button
                    onClick={() => setMacroView("breakdown")}
                    className={`rounded-lg px-2 py-1 text-xs font-medium transition ${
                      macroView === "breakdown"
                        ? "bg-sky-100 text-[#205278]"
                        : "text-slate-400 hover:text-slate-600"
                    }`}
                    type="button"
                  >
                    Breakdown
                  </button>
                </div>
              )}
            </div>

            {summaryView === "today" ? (
              macroView === "goals" ? (
                (() => {
                  const proteinGoal = Math.round((calorieGoal * 0.3) / 4);
                  const carbsGoal = Math.round((calorieGoal * 0.45) / 4);
                  const fatGoal = Math.round((calorieGoal * 0.25) / 9);

                  const macros = [
                    {
                      label: "Protein",
                      current: Math.round(dailySummary.totals.protein),
                      goal: proteinGoal,
                      unit: "g",
                      color: "bg-emerald-500",
                      accent: "text-emerald-600",
                    },
                    {
                      label: "Carbs",
                      current: Math.round(dailySummary.totals.carbs),
                      goal: carbsGoal,
                      unit: "g",
                      color: "bg-[#1e7cb6]",
                      accent: "text-[#1e7cb6]",
                    },
                    {
                      label: "Fat",
                      current: Math.round(dailySummary.totals.fat),
                      goal: fatGoal,
                      unit: "g",
                      color: "bg-amber-400",
                      accent: "text-amber-500",
                    },
                  ];

                  return (
                    <div className="mt-5 space-y-4">
                      {macros.map((macro) => {
                        const progress = Math.min(
                          100,
                          Math.round((macro.current / macro.goal) * 100),
                        );
                        return (
                          <div key={macro.label} className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <p className="text-lg font-semibold text-slate-800">
                                {macro.label}
                              </p>
                              <p
                                className={`text-sm font-semibold ${macro.accent}`}
                              >
                                {macro.current} / {macro.goal} {macro.unit}
                              </p>
                            </div>
                            <div className="h-4 rounded-md bg-sky-100">
                              <div
                                className={`h-4 rounded-md ${macro.color} transition-all`}
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <p className="text-xs text-slate-400 text-right">
                              {progress}% of daily goal
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              ) : (
                <div className="mt-5 space-y-4">
                  {[
                    {
                      label: "Protein",
                      value: macroPercentages.protein,
                      color: "bg-emerald-500",
                    },
                    {
                      label: "Carbs",
                      value: macroPercentages.carbs,
                      color: "bg-[#1e7cb6]",
                    },
                    {
                      label: "Fat",
                      value: macroPercentages.fat,
                      color: "bg-amber-400",
                    },
                  ].map((macro) => (
                    <div
                      key={macro.label}
                      className="grid items-center gap-3 sm:grid-cols-[78px,1fr,48px]"
                    >
                      <p className="text-lg font-semibold text-slate-800">
                        {macro.label}
                      </p>
                      <div className="h-4 rounded-md bg-sky-100">
                        <div
                          className={`h-4 rounded-md ${macro.color} transition-all`}
                          style={{ width: `${macro.value}%` }}
                        />
                      </div>
                      <p className="text-right text-lg font-semibold text-slate-800">
                        {macro.value}%
                      </p>
                    </div>
                  ))}
                </div>
              )
            ) : isLoadingProgress ? (
              <div className="mt-4 rounded-xl border border-white/70 bg-white/80 px-4 py-8 text-sm text-slate-500 shadow-sm">
                Loading macro trends...
              </div>
            ) : trendBuckets.length === 0 ? (
              <div className="mt-4 rounded-xl border border-white/70 bg-white/80 px-4 py-8 text-sm text-slate-500 shadow-sm">
                Trend data is unavailable for this view.
              </div>
            ) : (
              <MacroTrendPanel buckets={trendBuckets} />
            )}
          </section>

          <section className="rounded-xl border border-amber-200 bg-gradient-to-br from-[#fffdf8] to-[#fff4df] p-4 shadow-sm shadow-amber-100/70">
            <h2 className="text-[1.45rem] font-bold leading-tight text-slate-800 sm:text-[1.8rem]">
              Suggestion From Your Provider
            </h2>

            <div className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
              {fhirContext.providerSuggestions.map((suggestion) => (
                <p key={suggestion}>{suggestion}</p>
              ))}
            </div>
          </section>
        </div>
      </div>

      {isUtilityPanelOpen && (
        <div className="fixed inset-0 z-40 bg-slate-950/35">
          <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">
                  {utilityTab === "log" ? "Quick Log Meal" : "Meal History"}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  {formatDateLabel(selectedDate)}
                </p>
              </div>
              <button
                onClick={() => setIsUtilityPanelOpen(false)}
                className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex gap-2 border-b border-slate-200 px-6 py-3">
              <button
                onClick={() => setUtilityTab("log")}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  utilityTab === "log"
                    ? "bg-[#1e86c8] text-white"
                    : "bg-slate-100 text-slate-600"
                }`}
                type="button"
              >
                Quick Log
              </button>
              <button
                onClick={() => setUtilityTab("history")}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  utilityTab === "history"
                    ? "bg-[#1e86c8] text-white"
                    : "bg-slate-100 text-slate-600"
                }`}
                type="button"
              >
                History
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              {utilityTab === "log" ? (
                <MealLogComposer
                  compact
                  selectedDate={selectedDate}
                  onMealCreated={reloadSelectedDate}
                  onAfterSave={() => setUtilityTab("history")}
                />
              ) : (
                <MealHistoryList mealLogs={mealLogs} onDelete={deleteMeal} />
              )}
            </div>
          </div>
        </div>
      )}

      {showLinkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6">
            <h3 className="text-xl font-semibold text-slate-900">
              Link FHIR Patient
            </h3>

            <div className="mt-4 max-h-64 space-y-2 overflow-auto">
              {patientResults.length === 0 ? (
                isLoadingPatients ? (
                  <p className="text-sm text-slate-400 text-center py-4">
                    Loading patients...
                  </p>
                ) : patientLoadError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                    {patientLoadError}
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                    No FHIR patients found. Load Synthea patients into HAPI FHIR
                    or run the FHIR cache script, then try again.
                  </div>
                )
              ) : (
                patientResults.map((entry) => {
                  const name = entry.resource.name?.[0];
                  return (
                    <button
                      key={entry.resource.id}
                      onClick={() => void linkPatient(entry.resource.id)}
                      className="w-full rounded-lg border border-slate-200 p-3 text-left transition hover:bg-slate-50"
                      type="button"
                    >
                      {name?.given?.join(" ")} {name?.family}
                    </button>
                  );
                })
              )}
            </div>

            <button
              onClick={() => {
                setShowLinkModal(false);
                setPatientResults([]);
                setPatientLoadError(null);
                setIsLoadingPatients(false);
              }}
              className="mt-4 w-full text-slate-500"
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
