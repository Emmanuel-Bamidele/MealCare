import { Hono } from "hono";
import prisma from "./lib/prisma";
import { authMiddleware } from "./middleware";
import {
  buildProviderSuggestions,
  extractAllergyNames,
  extractConditionNames,
  buildFoodsToAvoid,
  isDietRelevant,
} from "./lib/fhir-context";

type ConditionBundle = {
  entry?: Array<{
    resource?: {
      id?: string;
      code?: {
        text?: string;
        coding?: Array<{ display?: string; code?: string }>;
      };
    };
  }>;
};

type AllergyBundle = {
  entry?: Array<{
    resource?: {
      id?: string;
      code?: { text?: string; coding?: Array<{ display?: string }> };
    };
  }>;
};

type PatientBundle = {
  entry?: Array<{
    resource?: {
      id?: string;
      name?: Array<{ given?: string[]; family?: string }>;
      birthDate?: string;
      gender?: string;
    };
  }>;
};

const router = new Hono<{ Variables: { userId: string } }>();
const FHIR_BASE_URL = "http://localhost:8080/fhir";

async function fetchFhirJson<T>(path: string): Promise<T> {
  const response = await fetch(`${FHIR_BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`FHIR request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

router.get("/patients", async (c) => {
  const cleanName = (name: string) => name.replace(/\d+/g, "").trim();

  try {
    const patients = await prisma.fhirPatient.findMany();

    if (patients.length === 0) {
      try {
        const bundle = await fetchFhirJson<PatientBundle>(
          "/Patient?_count=50&_format=json",
        );

        return c.json(
          (bundle.entry || [])
            .map((entry) => entry.resource)
            .filter((patient): patient is NonNullable<typeof patient> =>
              Boolean(patient?.id),
            )
            .map((patient) => ({
              resource: {
                id: patient.id,
                name: patient.name,
                birthDate: patient.birthDate,
                gender: patient.gender,
              },
            })),
        );
      } catch (error) {
        console.log("No cached patients and live FHIR patient lookup failed:", error);
      }
    }

    return c.json(
      patients.map((p) => ({
        resource: {
          id: p.fhirId,
          name: [
            { given: [cleanName(p.firstName)], family: cleanName(p.lastName) },
          ],
          birthDate: p.birthDate,
          gender: p.gender,
        },
      })),
    );
  } catch (err) {
    console.error("Failed to fetch patients:", err);
    return c.json({ error: "Unable to load patients" }, 500);
  }
});

router.post("/link", authMiddleware, async (c) => {
  const { fhirPatientId } = await c.req.json();
  const userId = c.get("userId");

  const user = await prisma.user.update({
    where: { id: userId },
    data: { fhirPatientId },
    select: { id: true, fhirPatientId: true },
  });

  if (fhirPatientId) {
    await prisma.userCondition.deleteMany({ where: { userId } });
    await prisma.userAllergy.deleteMany({ where: { userId } });

    let cached = false;

    try {
      const [conditionBundle, allergyBundle] = await Promise.all([
        fetchFhirJson<ConditionBundle>(
          `/Condition?patient=${fhirPatientId}&_format=json`,
        ),
        fetchFhirJson<AllergyBundle>(
          `/AllergyIntolerance?patient=${fhirPatientId}&_format=json`,
        ),
      ]);

      for (const entry of conditionBundle.entry || []) {
        const resource = entry.resource;
        if (!resource?.id) continue;
        await prisma.userCondition.upsert({
          where: { userId_fhirId: { userId, fhirId: resource.id } },
          update: {
            display:
              resource.code?.coding?.[0]?.display ||
              resource.code?.text ||
              "Unknown",
            code: resource.code?.coding?.[0]?.code || "unknown",
          },
          create: {
            userId,
            fhirId: resource.id,
            display:
              resource.code?.coding?.[0]?.display ||
              resource.code?.text ||
              "Unknown",
            code: resource.code?.coding?.[0]?.code || "unknown",
          },
        });
      }

      for (const entry of allergyBundle.entry || []) {
        const resource = entry.resource;
        if (!resource?.id) continue;
        await prisma.userAllergy.upsert({
          where: { userId_fhirId: { userId, fhirId: resource.id } },
          update: {
            substance:
              resource.code?.coding?.[0]?.display ||
              resource.code?.text ||
              "Unknown",
          },
          create: {
            userId,
            fhirId: resource.id,
            substance:
              resource.code?.coding?.[0]?.display ||
              resource.code?.text ||
              "Unknown",
          },
        });
      }

      cached = true;
      console.log(`Cached FHIR data from server for user ${userId}`);
    } catch {
      console.log("FHIR unavailable during link");
    }

    if (!cached) {
      const fhirPatient = await prisma.fhirPatient.findUnique({
        where: { fhirId: fhirPatientId },
      });

      if (fhirPatient) {
        const conditions = JSON.parse(fhirPatient.conditions || "[]");
        const allergies = JSON.parse(fhirPatient.allergies || "[]");

        for (const cond of conditions) {
          await prisma.userCondition.upsert({
            where: { userId_fhirId: { userId, fhirId: cond.fhirId } },
            update: { display: cond.display, code: cond.code },
            create: {
              userId,
              fhirId: cond.fhirId,
              display: cond.display,
              code: cond.code,
            },
          });
        }

        for (const allergy of allergies) {
          await prisma.userAllergy.upsert({
            where: { userId_fhirId: { userId, fhirId: allergy.fhirId } },
            update: { substance: allergy.substance },
            create: {
              userId,
              fhirId: allergy.fhirId,
              substance: allergy.substance,
            },
          });
        }

        console.log(
          `Loaded cached data from fhir_patients for ${fhirPatientId}`,
        );
      } else {
        console.log(`No cached data available for ${fhirPatientId}`);
      }
    }
  }

  return c.json({ message: "Patient linked successfully", user });
});

router.get("/context", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fhirPatientId: true },
  });

  if (!user?.fhirPatientId) {
    return c.json({
      patient: null,
      conditions: [],
      allergies: [],
      providerSuggestions: [
        "Link a FHIR patient to unlock condition-aware meal guidance and allergy reminders.",
      ],
    });
  }

  try {
    const [patient, conditionBundle, allergyBundle] = await Promise.all([
      fetchFhirJson(`/Patient/${user.fhirPatientId}`),
      fetchFhirJson<{
        entry?: Array<{
          resource?: {
            code?: { text?: string; coding?: Array<{ display?: string }> };
          };
        }>;
      }>(`/Condition?patient=${user.fhirPatientId}&_format=json`),
      fetchFhirJson<{
        entry?: Array<{
          resource?: {
            code?: { text?: string; coding?: Array<{ display?: string }> };
          };
        }>;
      }>(`/AllergyIntolerance?patient=${user.fhirPatientId}&_format=json`),
    ]);

    const conditions = extractConditionNames(conditionBundle);
    const allergies = extractAllergyNames(allergyBundle);

    return c.json({
      patient,
      conditions,
      allergies,
      providerSuggestions: buildProviderSuggestions(conditions, allergies),
    });
  } catch {
    console.log("FHIR unavailable, using cached data");

    const [cachedConditions, cachedAllergies] = await Promise.all([
      prisma.userCondition.findMany({ where: { userId } }),
      prisma.userAllergy.findMany({ where: { userId } }),
    ]);

    const conditionNames = cachedConditions
      .map((c) => c.display)
      .filter(isDietRelevant);
    const allergyNames = cachedAllergies.map((a) => a.substance);

    const fhirPatient = await prisma.fhirPatient.findUnique({
      where: { fhirId: user.fhirPatientId },
    });

    return c.json({
      patient: {
        id: user.fhirPatientId,
        birthDate: fhirPatient?.birthDate || null,
        gender: fhirPatient?.gender || null,
      },
      conditions: conditionNames,
      allergies: allergyNames,
      providerSuggestions: buildProviderSuggestions(
        conditionNames,
        allergyNames,
      ),
    });
  }
});

router.get("/foods-to-avoid", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fhirPatientId: true },
  });

  if (!user?.fhirPatientId) {
    return c.json({
      foods: [],
      message: "Link a FHIR patient to see personalized food recommendations.",
    });
  }

  let conditions: string[];
  let allergies: string[];

  try {
    const [conditionBundle, allergyBundle] = await Promise.all([
      fetchFhirJson<{
        entry?: Array<{
          resource?: {
            code?: { text?: string; coding?: Array<{ display?: string }> };
          };
        }>;
      }>(`/Condition?patient=${user.fhirPatientId}&_format=json`),
      fetchFhirJson<{
        entry?: Array<{
          resource?: {
            code?: { text?: string; coding?: Array<{ display?: string }> };
          };
        }>;
      }>(`/AllergyIntolerance?patient=${user.fhirPatientId}&_format=json`),
    ]);

    conditions = extractConditionNames(conditionBundle);
    allergies = extractAllergyNames(allergyBundle);
  } catch {
    console.log("FHIR unavailable, using cached data for foods-to-avoid");

    const [cachedConditions, cachedAllergies] = await Promise.all([
      prisma.userCondition.findMany({ where: { userId } }),
      prisma.userAllergy.findMany({ where: { userId } }),
    ]);

    conditions = cachedConditions.map((c) => c.display).filter(isDietRelevant);
    allergies = cachedAllergies.map((a) => a.substance);
  }

  const foods = buildFoodsToAvoid(conditions, allergies);
  return c.json({ foods, conditions, allergies });
});

router.get("/patient/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const patient = await fetchFhirJson(`/Patient/${id}`);
    return c.json(patient);
  } catch (error) {
    console.error(error);
    return c.json({ error: "Patient not found" }, 404);
  }
});

export default router;
