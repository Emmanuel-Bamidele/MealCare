import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Utensils,
  RefreshCw,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Search,
  MessageCircle,
  X,
  Send,
  Bot,
} from "lucide-react";
import api from "../lib/api";
import { searchFoods, type FoodSearchResult } from "../lib/meal-log";

type FoodItem = {
  name: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
};

type Meal = {
  items: FoodItem[];
  totalCalories: number;
};

type DayPlan = {
  day: string;
  meals: {
    breakfast: Meal;
    lunch: Meal;
    dinner: Meal;
    snack: Meal;
  };
  totalCalories: number;
};

type MealPlanResponse = {
  mealPlan: {
    days: DayPlan[];
    dailyCalorieTarget?: number;
    summary: string;
  };
  conditions: string[];
  allergies: string[];
};
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};
type UsdaMatchModal = {
  dayIndex: number;
  dayName: string;
  mealKey: MealKey;
  meal: Meal;
};

const MEAL_LABELS = ["breakfast", "lunch", "dinner", "snack"] as const;
type MealKey = (typeof MEAL_LABELS)[number];

function formatMealLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentWeekStart(): string {
  const today = new Date();
  const day = today.getDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysSinceMonday);
  return formatLocalDate(monday);
}

function getMealDate(weekStart: string, dayIndex: number): string {
  const date = new Date(`${weekStart}T00:00:00`);
  date.setDate(date.getDate() + dayIndex);
  return formatLocalDate(date);
}

export default function MealPlan() {
const [data, setData] = useState<MealPlanResponse | null>(() => {
  const saved = localStorage.getItem("mealPlan");
  return saved ? JSON.parse(saved) : null;
});
  const [weekStart, setWeekStart] = useState(getCurrentWeekStart);
  const [loading, setLoading] = useState(false);
  const [savingMeal, setSavingMeal] = useState<string | null>(null);
  const [savedMeals, setSavedMeals] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [matchModal, setMatchModal] = useState<UsdaMatchModal | null>(null);
  const [foodQuery, setFoodQuery] = useState("");
  const [foodResults, setFoodResults] = useState<FoodSearchResult[]>([]);
  const [selectedFoods, setSelectedFoods] = useState<FoodSearchResult[]>([]);
  const [isSearchingFoods, setIsSearchingFoods] = useState(false);
  const [foodSearchError, setFoodSearchError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Ask me about this meal plan, alternatives, macro impact, or what changes might mean for your saved plan.",
    },
  ]);

  const generatePlan = async () => {
  setLoading(true);
  setError(null);
  setSaveError(null);
  setSavedMeals({});

  try {
    const res = await api.post<MealPlanResponse>("/meal-plan/generate");
    setData(res.data);
    localStorage.setItem("mealPlan", JSON.stringify(res.data));
  } catch {
    setError("Failed to generate meal plan. Make sure you have a FHIR patient linked.");
  } finally {
    setLoading(false);
  }
};

  const saveMealToPlan = async (
    dayIndex: number,
    mealKey: MealKey,
    foods: FoodSearchResult[],
  ) => {
    const saveKey = `${dayIndex}-${mealKey}`;
    setSavingMeal(saveKey);
    setSaveError(null);

    try {
      await api.post("/meal-plan/items", {
        startDate: weekStart,
        dayOfWeek: dayIndex,
        mealType: mealKey,
        items: foods.map((food) => ({
          fdcId: food.fdcId,
          name: food.name,
          brand: food.brand,
          calories: food.calories,
          protein: food.protein,
          carbs: food.carbs,
          fat: food.fat,
          servingSize: food.servingSize,
          servingUnit: food.servingUnit,
        })),
      });

      setSavedMeals((current) => ({
        ...current,
        [saveKey]: getMealDate(weekStart, dayIndex),
      }));
      closeMatchModal();
    } catch {
      setSaveError(`Failed to save ${formatMealLabel(mealKey)} to your plan.`);
    } finally {
      setSavingMeal(null);
    }
  };

  const openMatchModal = (dayIndex: number, dayName: string, mealKey: MealKey, meal: Meal) => {
    const firstSuggestion = meal.items[0]?.name ?? "";
    setMatchModal({ dayIndex, dayName, mealKey, meal });
    setFoodQuery(firstSuggestion);
    setFoodResults([]);
    setSelectedFoods([]);
    setFoodSearchError(null);
    if (firstSuggestion) {
      void runFoodSearch(firstSuggestion);
    }
  };

  const closeMatchModal = () => {
    setMatchModal(null);
    setFoodQuery("");
    setFoodResults([]);
    setSelectedFoods([]);
    setFoodSearchError(null);
  };

  const runFoodSearch = async (query = foodQuery) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setFoodResults([]);
      return;
    }

    setIsSearchingFoods(true);
    setFoodSearchError(null);

    try {
      const results = await searchFoods(trimmed);
      setFoodResults(results);
    } catch {
      setFoodSearchError("Unable to search USDA foods right now.");
      setFoodResults([]);
    } finally {
      setIsSearchingFoods(false);
    }
  };

  const toggleSelectedFood = (food: FoodSearchResult) => {
    setSelectedFoods((current) => {
      const exists = current.some((item) => item.fdcId === food.fdcId);
      if (exists) {
        return current.filter((item) => item.fdcId !== food.fdcId);
      }
      return [...current, food];
    });
  };

  const sendChatMessage = async () => {
    const message = chatInput.trim();
    if (!message || chatLoading) return;

    setChatInput("");
    setChatError(null);
    setChatLoading(true);
    setChatMessages((current) => [...current, { role: "user", content: message }]);

    try {
      const res = await api.post<{ reply: string }>("/meal-plan/chat", {
        message,
        weekStart,
        draftMealPlan: data?.mealPlan ?? null,
      });

      setChatMessages((current) => [
        ...current,
        { role: "assistant", content: res.data.reply },
      ]);
    } catch {
      setChatError("I could not answer that meal-plan question right now.");
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="premium-page min-h-full px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-col gap-4 rounded-lg border border-slate-200 bg-white/90 p-5 shadow-sm shadow-slate-200/70 backdrop-blur lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="premium-title">Meal Plan</h1>
          <p className="premium-caption mt-1">
            Generate suggestions, match them to USDA foods, and save only what you choose.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <span className="font-medium">Week starts</span>
            <input
              type="date"
              value={weekStart}
              onChange={(event) => {
                setWeekStart(event.target.value);
                setSavedMeals({});
              }}
              className="premium-input px-2 py-1"
            />
          </label>
          <button
            onClick={generatePlan}
            disabled={loading}
            className="premium-button-primary px-5 py-2.5"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Utensils className="w-4 h-4" />
                Generate Meal Plan
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {saveError && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <p className="text-sm text-red-700">{saveError}</p>
        </div>
      )}

      {!data && !loading && !error && (
        <div className="premium-panel p-12 text-center">
          <Utensils className="w-12 h-12 mx-auto mb-3 text-slate-300" />
          <p className="text-slate-500">
            Click "Generate Meal Plan" to create a personalized weekly meal plan based on your linked FHIR patient data.
          </p>
        </div>
      )}

      {loading && (
        <div className="premium-panel p-12 text-center">
          <RefreshCw className="w-12 h-12 mx-auto mb-3 text-emerald-400 animate-spin" />
          <p className="text-slate-500">
            Analyzing your health profile and generating a personalized meal plan...
          </p>
        </div>
      )}

      {data && (
        <div className="space-y-6">
         {/* Summary */}
<div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
  <p className="text-sm font-semibold text-emerald-800 mb-1">
    Personalized meal plan generated based on your FHIR health profile
  </p>
  {data.mealPlan.dailyCalorieTarget && (
    <p className="text-sm text-emerald-700">
      Daily calorie target: {data.mealPlan.dailyCalorieTarget} kcal
    </p>
  )}
</div>

          {/* Conditions & Allergies */}
          <div className="flex flex-wrap gap-3">
            {data.conditions.length > 0 && (
              <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2">
                <p className="text-xs text-sky-800">
                  <span className="font-semibold">Conditions:</span>{" "}
                  {data.conditions.join(", ")}
                </p>
              </div>
            )}
            {data.allergies.length > 0 && (
              <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2">
                <p className="text-xs text-rose-800">
                  <span className="font-semibold">Allergies:</span>{" "}
                  {data.allergies.join(", ")}
                </p>
              </div>
            )}
          </div>

          {/* Weekly Plan */}
          {data.mealPlan.days.map((day) => (
            <div
              key={day.day}
              className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm shadow-slate-200/60"
            >
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-3">
                <div>
                  <h2 className="font-semibold text-slate-800">{day.day}</h2>
                  <p className="text-xs text-slate-500">
                    Saves to {getMealDate(weekStart, data.mealPlan.days.indexOf(day))}
                  </p>
                </div>
                <span className="text-sm font-medium text-emerald-600">
                  {day.totalCalories} kcal
                </span>
              </div>

              <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4">
                {MEAL_LABELS.map((mealKey) => {
                  const meal = day.meals[mealKey];
                  const dayIndex = data.mealPlan.days.indexOf(day);
                  const saveKey = `${dayIndex}-${mealKey}`;
                  const isSaving = savingMeal === saveKey;
                  const savedDate = savedMeals[saveKey];
                  return (
                    <div key={mealKey} className="bg-white p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-semibold text-slate-700">
                          {formatMealLabel(mealKey)}
                        </p>
                        <span className="text-xs font-semibold text-emerald-600">
                          {meal.totalCalories} kcal
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {meal.items.map((item, i) => (
                          <div
                            key={i}
                            className="rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2 text-sm"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-slate-600">{item.name}</span>
                              <span className="shrink-0 text-xs text-slate-400">
                                {item.calories} kcal
                              </span>
                            </div>
                            {(item.protein || item.carbs || item.fat) && (
                              <p className="mt-1 text-[11px] text-slate-400">
                                P {item.protein ?? 0}g / C {item.carbs ?? 0}g / F {item.fat ?? 0}g
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => openMatchModal(dayIndex, day.day, mealKey, meal)}
                        disabled={isSaving}
                        className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          savedDate
                            ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                            : "border border-slate-200 bg-white text-slate-700 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"
                        }`}
                      >
                        {isSaving ? (
                          <>
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            Saving...
                          </>
                        ) : savedDate ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Saved for {savedDate}
                          </>
                        ) : (
                          <>
                            <Search className="h-3.5 w-3.5" />
                            Match USDA {formatMealLabel(mealKey)}
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {matchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-800">
                  Match {matchModal.dayName} {formatMealLabel(matchModal.mealKey)} to USDA foods
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Select USDA foods to save accurate nutrition values into your plan.
                </p>
              </div>
              <button
                type="button"
                onClick={closeMatchModal}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close USDA match modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4">
              <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                  AI suggestion
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {matchModal.meal.items.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => {
                        setFoodQuery(item.name);
                        void runFoodSearch(item.name);
                      }}
                      className="rounded-full border border-amber-200 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </div>

              <form
                className="mt-4 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runFoodSearch();
                }}
              >
                <input
                  value={foodQuery}
                  onChange={(event) => setFoodQuery(event.target.value)}
                  placeholder="Search USDA foods..."
                  className="premium-input min-w-0 flex-1"
                />
                <button
                  type="submit"
                  disabled={isSearchingFoods || foodQuery.trim().length < 2}
                  className="premium-button-primary"
                >
                  {isSearchingFoods ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Search
                </button>
              </form>

              {foodSearchError && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {foodSearchError}
                </div>
              )}

              {selectedFoods.length > 0 && (
                <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    Selected for plan
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedFoods.map((food) => (
                      <button
                        key={food.fdcId}
                        type="button"
                        onClick={() => toggleSelectedFood(food)}
                        className="rounded-full border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100"
                      >
                        {food.name} · {Math.round(food.calories)} kcal
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                {foodResults.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-slate-500">
                    Search for matching USDA foods, then select one or more results.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {foodResults.map((food) => {
                      const selected = selectedFoods.some(
                        (item) => item.fdcId === food.fdcId,
                      );

                      return (
                        <button
                          key={food.fdcId}
                          type="button"
                          onClick={() => toggleSelectedFood(food)}
                          className={`flex w-full items-start justify-between gap-4 px-4 py-3 text-left transition ${
                            selected ? "bg-emerald-50" : "bg-white hover:bg-slate-50"
                          }`}
                        >
                          <div>
                            <p className="text-sm font-semibold text-slate-800">
                              {food.name}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {food.brand || "Generic"} · {food.servingSize} {food.servingUnit}
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                              P {Math.round(food.protein)}g / C {Math.round(food.carbs)}g / F {Math.round(food.fat)}g
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-emerald-600">
                              {Math.round(food.calories)} kcal
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                              {selected ? "Selected" : "Select"}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeMatchModal}
                className="premium-button-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  saveMealToPlan(
                    matchModal.dayIndex,
                    matchModal.mealKey,
                    selectedFoods,
                  )
                }
                disabled={
                  selectedFoods.length === 0 ||
                  savingMeal === `${matchModal.dayIndex}-${matchModal.mealKey}`
                }
                className="premium-button-primary"
              >
                {savingMeal === `${matchModal.dayIndex}-${matchModal.mealKey}` && (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                )}
                Save USDA Selection
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="fixed bottom-5 right-5 z-50">
        {chatOpen ? (
          <div className="flex h-[34rem] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl shadow-slate-900/20">
            <div className="flex items-center justify-between bg-[#174c72] px-4 py-3 text-white">
              <div className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                <div>
                  <p className="text-sm font-semibold">Meal Plan Assistant</p>
                  <p className="text-xs text-sky-100">Plan questions only</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setChatOpen(false)}
                className="rounded-md p-1.5 text-sky-50 transition hover:bg-white/10"
                aria-label="Close meal plan assistant"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50/80 px-4 py-4">
              {chatMessages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                      message.role === "user"
                        ? "bg-[#176b9f] text-white"
                        : "border border-slate-200 bg-white text-slate-700"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          ul: ({ children }) => (
                            <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">
                              {children}
                            </ul>
                          ),
                          ol: ({ children }) => (
                            <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">
                              {children}
                            </ol>
                          ),
                          li: ({ children }) => <li className="pl-1">{children}</li>,
                          strong: ({ children }) => (
                            <strong className="font-semibold text-slate-900">
                              {children}
                            </strong>
                          ),
                          code: ({ children }) => (
                            <code className="rounded bg-slate-100 px-1 py-0.5 text-[0.82em] text-slate-800">
                              {children}
                            </code>
                          ),
                          a: ({ children, href }) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2"
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    ) : (
                      message.content
                    )}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Thinking...
                  </div>
                </div>
              )}
              {chatError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {chatError}
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 bg-white p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendChatMessage();
                    }
                  }}
                  rows={2}
                  maxLength={1200}
                  placeholder="Ask about alternatives, macros, or plan changes..."
                  className="premium-input min-h-12 flex-1 resize-none"
                />
                <button
                  type="button"
                  onClick={sendChatMessage}
                  disabled={!chatInput.trim() || chatLoading}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#176b9f] text-white transition hover:bg-[#145d8a] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Send meal plan question"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-[#174c72] text-white shadow-xl shadow-slate-900/20 transition hover:bg-[#176b9f]"
            aria-label="Open meal plan assistant"
          >
            <MessageCircle className="h-6 w-6" />
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
