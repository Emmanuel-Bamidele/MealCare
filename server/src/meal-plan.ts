import { Hono } from "hono";
import Groq from "groq-sdk";
import OpenAI from "openai";
import { MealType } from "@prisma/client";
import prisma from "./lib/prisma";
import { authMiddleware } from "./middleware";
import { isDietRelevant } from "./lib/fhir-context";

const router = new Hono<{ Variables: { userId: string } }>();

type AiProvider = "groq" | "openai";
type GeneratedMealItem = {
  fdcId?: number;
  name: string;
  brand?: string | null;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  servingSize?: number;
  servingUnit?: string;
};
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const DAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const MEAL_TYPE_MAP = {
  breakfast: MealType.BREAKFAST,
  lunch: MealType.LUNCH,
  dinner: MealType.DINNER,
  snack: MealType.SNACK,
} as const;

function resolveAiProvider():
  | { provider: AiProvider; apiKey: string; model: string }
  | { error: string } {
  const requestedProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
  const groqApiKey = process.env.GROQ_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;

  if (requestedProvider && requestedProvider !== "groq" && requestedProvider !== "openai") {
    return { error: "AI_PROVIDER must be either 'groq' or 'openai'" };
  }

  if (requestedProvider === "openai") {
    if (!openAiApiKey) {
      return { error: "OPENAI_API_KEY is required when AI_PROVIDER=openai" };
    }

    return {
      provider: "openai",
      apiKey: openAiApiKey,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }

  if (requestedProvider === "groq") {
    if (!groqApiKey) {
      return { error: "GROQ_API_KEY is required when AI_PROVIDER=groq" };
    }

    return {
      provider: "groq",
      apiKey: groqApiKey,
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    };
  }

  if (groqApiKey) {
    return {
      provider: "groq",
      apiKey: groqApiKey,
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    };
  }

  if (openAiApiKey) {
    return {
      provider: "openai",
      apiKey: openAiApiKey,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }

  return { error: "Meal plan generation is not configured" };
}

function cleanJsonResponse(text: string) {
  return text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
}

function stringifyForPrompt(value: unknown, maxLength = 12000) {
  const text = JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...truncated` : text;
}

function parseDateOnly(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} is invalid`);
  }

  return date;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toFiniteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeGeneratedItems(value: unknown): GeneratedMealItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("items must include at least one food");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Each item must be an object");
    }

    const candidate = item as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";

    if (!name) {
      throw new Error("Each item needs a name");
    }

    return {
      fdcId:
        typeof candidate.fdcId === "number" && Number.isFinite(candidate.fdcId)
          ? candidate.fdcId
          : undefined,
      name,
      brand: typeof candidate.brand === "string" ? candidate.brand : null,
      calories: Math.max(0, toFiniteNumber(candidate.calories)),
      protein: Math.max(0, toFiniteNumber(candidate.protein)),
      carbs: Math.max(0, toFiniteNumber(candidate.carbs)),
      fat: Math.max(0, toFiniteNumber(candidate.fat)),
      servingSize: Math.max(0, toFiniteNumber(candidate.servingSize, 1)),
      servingUnit:
        typeof candidate.servingUnit === "string" && candidate.servingUnit.trim()
          ? candidate.servingUnit.trim()
          : "serving",
    };
  });
}

async function generateMealPlanText(
  providerConfig: { provider: AiProvider; apiKey: string; model: string },
  prompt: string,
) {
  return generateAiText(providerConfig, [{ role: "user", content: prompt }], 4000, 1.0);
}

async function generateAiText(
  providerConfig: { provider: AiProvider; apiKey: string; model: string },
  messages: ChatMessage[],
  maxTokens: number,
  temperature = 0.4,
) {
  if (providerConfig.provider === "openai") {
    const openai = new OpenAI({ apiKey: providerConfig.apiKey });
    const response = await openai.responses.create({
      model: providerConfig.model,
      input: messages
        .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
        .join("\n\n"),
      max_output_tokens: maxTokens,
    });

    return response.output_text || "";
  }

  const groq = new Groq({ apiKey: providerConfig.apiKey });
  const response = await groq.chat.completions.create({
    model: providerConfig.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content || "";
}

router.post("/generate", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const providerConfig = resolveAiProvider();

  if ("error" in providerConfig) {
    return c.json({ error: providerConfig.error }, 500);
  }

  const [user, conditions, allergies] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { weightLbs: true, heightIn: true, fhirPatientId: true },
    }),
    prisma.userCondition.findMany({ where: { userId } }),
    prisma.userAllergy.findMany({ where: { userId } }),
  ]);

  let age: number | null = null;
  let gender: string | null = null;

  if (user?.fhirPatientId) {
    const fhirPatient = await prisma.fhirPatient.findUnique({
      where: { fhirId: user.fhirPatientId },
    });

    if (fhirPatient) {
      gender = fhirPatient.gender;
      if (fhirPatient.birthDate) {
        const birth = new Date(fhirPatient.birthDate);
        age = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      }
    }
  }

  let calorieTarget = 2000;

  if (user?.weightLbs && user?.heightIn && age && gender) {
    const weightKg = user.weightLbs * 0.453592;
    const heightCm = user.heightIn * 2.54;

    if (gender === "male") {
      calorieTarget = Math.round(((10 * weightKg) + (6.25 * heightCm) - (5 * age) + 5) * 1.375);
    } else {
      calorieTarget = Math.round(((10 * weightKg) + (6.25 * heightCm) - (5 * age) - 161) * 1.375);
    }
  }

  const conditionNames = conditions
    .map((c) => c.display)
    .filter(isDietRelevant);
  const allergyNames = allergies.map((a) => a.substance);

  const profileContext = [
    user?.weightLbs ? `Weight: ${user.weightLbs} lbs` : null,
    user?.heightIn ? `Height: ${user.heightIn} inches` : null,
    age ? `Age: ${age} years old` : null,
    gender ? `Sex: ${gender}` : null,
  ].filter(Boolean).join(", ");

  const conditionContext = conditionNames.length > 0
    ? `The patient has the following conditions: ${conditionNames.join(", ")}.`
    : "The patient has no specific medical conditions.";

  const allergyContext = allergyNames.length > 0
    ? `The patient has the following allergies: ${allergyNames.join(", ")}. These foods must be completely avoided.`
    : "The patient has no known allergies.";

  const bkfast = Math.round(calorieTarget * 0.25);
  const lunch = Math.round(calorieTarget * 0.30);
  const dinner = Math.round(calorieTarget * 0.30);
  const snack = Math.round(calorieTarget * 0.15);

  const prompt = `You are a clinical dietitian. Generate a 7-day meal plan for a patient based on their health profile.

Patient profile: ${profileContext || "No biometric data available."}
${conditionContext}
${allergyContext}

Requirements:
- Vary the meals creatively. Do not repeat the same foods across different days. Each day should feel distinct.
- Create meals for each day (Monday through Sunday)
- Each day should have Breakfast, Lunch, Dinner, and Snack
- Each meal should include 1-3 food items with estimated calories, protein, carbs, and fat
- Tailor the meals to help manage the patient's conditions
- Avoid any allergens completely
- The daily calorie target is ${calorieTarget} kcal. All days should total close to this number.

Respond ONLY with valid JSON in this exact format, no markdown, no explanation:
{
  "days": [
    {
      "day": "Monday",
      "meals": {
        "breakfast": {
          "items": [{"name": "food name", "calories": ${bkfast}, "protein": 20, "carbs": 30, "fat": 10}],
          "totalCalories": ${bkfast}
        },
        "lunch": {
          "items": [{"name": "food name", "calories": ${lunch}, "protein": 30, "carbs": 45, "fat": 15}],
          "totalCalories": ${lunch}
        },
        "dinner": {
          "items": [{"name": "food name", "calories": ${dinner}, "protein": 35, "carbs": 40, "fat": 18}],
          "totalCalories": ${dinner}
        },
        "snack": {
          "items": [{"name": "food name", "calories": ${snack}, "protein": 10, "carbs": 20, "fat": 8}],
          "totalCalories": ${snack}
        }
      },
      "totalCalories": ${calorieTarget}
    }
  ],
  "dailyCalorieTarget": ${calorieTarget},
  "summary": "Brief explanation of why this meal plan suits the patient's conditions"
}`;

  try {
    let mealPlan = null;
    let attempts = 0;

    while (!mealPlan && attempts < 3) {
      attempts++;
      try {
        const text = await generateMealPlanText(providerConfig, prompt);
        const clean = cleanJsonResponse(text);
        mealPlan = JSON.parse(clean);
      } catch {
        console.log(
          `${providerConfig.provider} meal plan parse failed, attempt ${attempts}/3`,
        );
      }
    }

    if (!mealPlan) {
      return c.json({ error: "Failed to generate meal plan after multiple attempts" }, 500);
    }

    return c.json({
      mealPlan,
      conditions: conditionNames,
      allergies: allergyNames,
      provider: providerConfig.provider,
      model: providerConfig.model,
    });
  } catch (err) {
    console.error("Meal plan generation failed:", err);
    return c.json({ error: "Failed to generate meal plan" }, 500);
  }
});

router.get("/current", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const rawDate = c.req.query("date");
  let date: Date;

  try {
    date = parseDateOnly(rawDate, "date");
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }

  const plan = await prisma.mealPlan.findFirst({
    where: {
      userId,
      startDate: { lte: date },
      endDate: { gte: date },
    },
    include: {
      items: {
        include: { foodItem: true },
        orderBy: [{ dayOfWeek: "asc" }, { mealType: "asc" }],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!plan) {
    return c.json({ plan: null });
  }

  const grouped = DAY_LABELS.map((day, dayOfWeek) => {
    const dayItems = plan.items.filter((item) => item.dayOfWeek === dayOfWeek);

    return {
      day,
      dayOfWeek,
      meals: Object.values(MealType).reduce(
        (acc, mealType) => {
          const items = dayItems
            .filter((item) => item.mealType === mealType)
            .map((item) => ({
              id: item.id,
              servings: item.servings,
              food: item.foodItem,
            }));

          const totals = items.reduce(
            (sum, item) => ({
              calories: sum.calories + item.food.calories * item.servings,
              protein: sum.protein + item.food.protein * item.servings,
              carbs: sum.carbs + item.food.carbs * item.servings,
              fat: sum.fat + item.food.fat * item.servings,
            }),
            { calories: 0, protein: 0, carbs: 0, fat: 0 },
          );

          acc[mealType.toLowerCase() as Lowercase<MealType>] = {
            items,
            totals,
          };

          return acc;
        },
        {} as Record<
          Lowercase<MealType>,
          {
            items: Array<{
              id: string;
              servings: number;
              food: {
                id: string;
                name: string;
                calories: number;
                protein: number;
                carbs: number;
                fat: number;
              };
            }>;
            totals: { calories: number; protein: number; carbs: number; fat: number };
          }
        >,
      ),
    };
  });

  return c.json({ plan: { ...plan, days: grouped } });
});

router.post("/items", authMiddleware, async (c) => {
  const userId = c.get("userId");
  let payload: Record<string, unknown>;

  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  let startDate: Date;
  let dayOfWeek: number;
  let mealType: MealType;
  let items: GeneratedMealItem[];

  try {
    startDate = parseDateOnly(payload.startDate, "startDate");
    const rawDayOfWeek = payload.dayOfWeek;
    if (
      typeof rawDayOfWeek !== "number" ||
      !Number.isInteger(rawDayOfWeek) ||
      rawDayOfWeek < 0 ||
      rawDayOfWeek > 6
    ) {
      throw new Error("dayOfWeek must be an integer from 0 to 6");
    }
    dayOfWeek = rawDayOfWeek;

    const rawMealType =
      typeof payload.mealType === "string" ? payload.mealType.toLowerCase() : "";
    mealType = MEAL_TYPE_MAP[rawMealType as keyof typeof MEAL_TYPE_MAP];
    if (!mealType) {
      throw new Error("mealType must be breakfast, lunch, dinner, or snack");
    }

    items = normalizeGeneratedItems(payload.items);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }

  const endDate = addDays(startDate, 6);
  const result = await prisma.$transaction(async (tx) => {
    let plan = await tx.mealPlan.findFirst({
      where: { userId, startDate, endDate },
      orderBy: { createdAt: "desc" },
    });

    if (!plan) {
      plan = await tx.mealPlan.create({
        data: {
          userId,
          name: `AI meal plan for week of ${startDate.toISOString().slice(0, 10)}`,
          startDate,
          endDate,
        },
      });
    }

    await tx.mealPlanItem.deleteMany({
      where: {
        mealPlanId: plan.id,
        dayOfWeek,
        mealType,
      },
    });

    const savedItems = [];

    for (const item of items) {
      const foodItem = item.fdcId
        ? await tx.foodItem.upsert({
            where: { usdaFdcId: String(item.fdcId) },
            update: {
              name: item.name,
              brand: item.brand || null,
              servingSize: item.servingSize ?? 1,
              servingUnit: item.servingUnit ?? "serving",
              calories: item.calories,
              protein: item.protein ?? 0,
              carbs: item.carbs ?? 0,
              fat: item.fat ?? 0,
            },
            create: {
              usdaFdcId: String(item.fdcId),
              name: item.name,
              brand: item.brand || null,
              servingSize: item.servingSize ?? 1,
              servingUnit: item.servingUnit ?? "serving",
              calories: item.calories,
              protein: item.protein ?? 0,
              carbs: item.carbs ?? 0,
              fat: item.fat ?? 0,
            },
          })
        : await tx.foodItem.create({
            data: {
              name: item.name,
              brand: item.brand || "Manual planned food",
              servingSize: item.servingSize ?? 1,
              servingUnit: item.servingUnit ?? "serving",
              calories: item.calories,
              protein: item.protein ?? 0,
              carbs: item.carbs ?? 0,
              fat: item.fat ?? 0,
            },
          });

      savedItems.push(
        await tx.mealPlanItem.create({
          data: {
            mealPlanId: plan.id,
            foodItemId: foodItem.id,
            mealType,
            dayOfWeek,
            servings: 1,
          },
          include: { foodItem: true },
        }),
      );
    }

    return { plan, items: savedItems };
  });

  return c.json({
    message: `${MEAL_TYPE_MAP[mealType.toLowerCase() as keyof typeof MEAL_TYPE_MAP] ?? mealType} saved to meal plan`,
    plan: result.plan,
    items: result.items,
  });
});

router.delete("/items", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const rawDate = c.req.query("date");
  const rawMealType = c.req.query("mealType");
  let date: Date;
  let mealType: MealType;

  try {
    date = parseDateOnly(rawDate, "date");
    const normalizedMealType = rawMealType?.toLowerCase() ?? "";
    mealType = MEAL_TYPE_MAP[normalizedMealType as keyof typeof MEAL_TYPE_MAP];

    if (!mealType) {
      throw new Error("mealType must be breakfast, lunch, dinner, or snack");
    }
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }

  const plan = await prisma.mealPlan.findFirst({
    where: {
      userId,
      startDate: { lte: date },
      endDate: { gte: date },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!plan) {
    return c.json({ error: "Meal plan not found" }, 404);
  }

  const diffDays = Math.round(
    (date.getTime() - plan.startDate.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (diffDays < 0 || diffDays > 6) {
    return c.json({ error: "Date is outside the meal plan range" }, 400);
  }

  const result = await prisma.mealPlanItem.deleteMany({
    where: {
      mealPlanId: plan.id,
      dayOfWeek: diffDays,
      mealType,
    },
  });

  return c.json({
    message: "Planned meal removed",
    removedCount: result.count,
  });
});

router.post("/chat", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const providerConfig = resolveAiProvider();

  if ("error" in providerConfig) {
    return c.json({ error: providerConfig.error }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }
  if (message.length > 1200) {
    return c.json({ error: "message must be 1200 characters or less" }, 400);
  }

  let weekStart: Date | null = null;
  if (payload.weekStart !== undefined) {
    try {
      weekStart = parseDateOnly(payload.weekStart, "weekStart");
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  }

  const weekEnd = weekStart ? addDays(weekStart, 6) : null;
  const [user, conditions, allergies, savedPlan, recentLogs] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        weightLbs: true,
        heightIn: true,
        fhirPatientId: true,
      },
    }),
    prisma.userCondition.findMany({ where: { userId } }),
    prisma.userAllergy.findMany({ where: { userId } }),
    weekStart && weekEnd
      ? prisma.mealPlan.findFirst({
          where: {
            userId,
            startDate: { lte: weekStart },
            endDate: { gte: weekStart },
          },
          include: {
            items: {
              include: { foodItem: true },
              orderBy: [{ dayOfWeek: "asc" }, { mealType: "asc" }],
            },
          },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
    prisma.mealLog.findMany({
      where: { userId },
      include: { items: { include: { foodItem: true } } },
      orderBy: { loggedAt: "desc" },
      take: 20,
    }),
  ]);

  const savedPlanContext = savedPlan
    ? {
        name: savedPlan.name,
        startDate: savedPlan.startDate,
        endDate: savedPlan.endDate,
        items: savedPlan.items.map((item) => ({
          day: DAY_LABELS[item.dayOfWeek] || `Day ${item.dayOfWeek}`,
          mealType: item.mealType,
          servings: item.servings,
          food: {
            name: item.foodItem.name,
            calories: item.foodItem.calories,
            protein: item.foodItem.protein,
            carbs: item.foodItem.carbs,
            fat: item.foodItem.fat,
            servingSize: item.foodItem.servingSize,
            servingUnit: item.foodItem.servingUnit,
          },
        })),
      }
    : null;

  const recentLogContext = recentLogs.map((log) => ({
    loggedAt: log.loggedAt,
    mealType: log.mealType,
    notes: log.notes,
    items: log.items.map((item) => ({
      servings: item.servings,
      food: {
        name: item.foodItem.name,
        calories: item.foodItem.calories,
        protein: item.foodItem.protein,
        carbs: item.foodItem.carbs,
        fat: item.foodItem.fat,
      },
    })),
  }));

  const context = {
    user: {
      firstName: user?.firstName,
      weightLbs: user?.weightLbs,
      heightIn: user?.heightIn,
      hasLinkedFhirPatient: Boolean(user?.fhirPatientId),
    },
    conditions: conditions.map((condition) => condition.display).filter(isDietRelevant),
    allergies: allergies.map((allergy) => allergy.substance),
    selectedWeek: weekStart
      ? {
          startDate: weekStart.toISOString().slice(0, 10),
          endDate: weekEnd?.toISOString().slice(0, 10),
        }
      : null,
    savedPlan: savedPlanContext,
    draftGeneratedPlan: payload.draftMealPlan ?? null,
    recentLoggedMeals: recentLogContext,
  };

  const systemPrompt = `You are MealCare's meal plan assistant.
Only answer questions about this user's meal plan, generated draft plan, saved planned meals, logged meals, food alternatives, nutrition/macros, allergies, and listed health conditions.
If the user asks about anything outside meal planning or nutrition for this app, briefly refuse and redirect to meal-plan help.
Use only the provided app context. Do not invent saved meals, allergies, conditions, logged meals, or app actions.
Do not diagnose disease, prescribe treatment, or replace a clinician. For medical uncertainty, recommend checking with a healthcare professional.
When suggesting alternatives, respect allergies and listed conditions, and try to keep calories/macros close to the original meal.
If the user wants to add, save, or edit a meal, explain what they can do in the app; do not claim you made changes.`;

  const userPrompt = `App context:
${stringifyForPrompt(context)}

User question:
${message}

Answer in 1-4 short paragraphs or concise bullets. Stay within scope.`;

  try {
    const reply = await generateAiText(
      providerConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      900,
    );

    return c.json({
      reply: reply.trim(),
      provider: providerConfig.provider,
      model: providerConfig.model,
    });
  } catch (error) {
    console.error("Meal plan chat failed:", error);
    return c.json({ error: "Failed to answer meal plan question" }, 500);
  }
});

export default router;
