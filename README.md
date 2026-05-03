# MealCare

Integrating FHIR resources into a meal planning and diet tracking web application.

**CS 6440 Health Informatics, Team 113**



## Tech Stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS
- **Backend:** Node.js + Hono
- **Database:** PostgreSQL/Prisma
- **FHIR Server:** HAPI FHIR through Docker
- **Synthetic FHIR Patient Data:** Synthea


## Prerequisites

- **Node.js** [nodejs.org](https://nodejs.org)
- **PostgreSQL** 14+ Install via [Homebrew](https://brew.sh): `brew install postgresql@14`
- **Docker**  [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)
- **Java**  https://www.java.com/en/download/ (only needed for Synthea)
- **Git** https://git-scm.com/
- **Optional:** PgAdmin for database management: https://www.pgadmin.org/download/


### Clone the Repository

```bash
git clone https://github.com/LeonardoGalan/MealCare.git
cd MealCare
```

### Install Dependencies

```bash
cd server
npm install
```

### Set Up PostgreSQL

Start PostgreSQL if it isn't already running:

```bash
brew services start postgresql@14
```

Create the database:

```bash
createdb mealcare
```


Add an .env file within the server folder and set your database URL + USDA key.

```
DATABASE_URL="postgresql://YOUR_USERNAME@localhost:5432/mealcare"
JWT_SECRET="your-key"
USDA_API_KEY="your_usda_api_key_here"
GROQ_API_KEY="your_groq_api_key_here"
```
We decided to use USDA FoodData Central as our external API for food search options due to being a government-verified and extremely detailed source while having US-focused food information. 

**NOTE** : To get USDA API Key, please go to https://fdc.nal.usda.gov/api-key-signup

Meal plan generation supports Groq by default and OpenAI as an optional provider.
Existing Groq setups do not need to change. To use OpenAI instead, add:

```
OPENAI_API_KEY="your_openai_api_key_here"
AI_PROVIDER="openai"
OPENAI_MODEL="gpt-4o-mini"
```

If `AI_PROVIDER` is not set, the server uses `GROQ_API_KEY` first when present, then falls back to `OPENAI_API_KEY`.

###  Run Prisma Migration

Create all the database tables:

```bash
cd server
npx prisma migrate dev --name init
npx prisma generate
```


###  Set Up HAPI FHIR Server

Make sure Docker is installed and running, then pull the latest HAPI FHIR image:

```bash
docker run -d -p 8080:8080 --name hapi-fhir hapiproject/hapi:latest
```

Verify that it is running by visiting:

```
http://localhost:8080/
```


### Generate and POST Synthea Patients to the FHIR Server

Clone the Synthea repo and generate 1-3 synthetic patient bundles:

```bash
cd ~
git clone https://github.com/synthetichealth/synthea.git
cd synthea
./run_synthea -p 3
```

Upload the hospital/practitioner data first, then 3 patient bundles to the FHIR server:

```bash
cd ~/synthea/output/fhir

for f in hospitalInformation*.json; do
  curl -X POST http://localhost:8080/fhir \
    -H "Content-Type: application/fhir+json" \
    -d @"$f"
done

for f in practitionerInformation*.json; do
  curl -X POST http://localhost:8080/fhir \
    -H "Content-Type: application/fhir+json" \
    -d @"$f"
done

count=0

for f in *.json; do
  if [[ "$f" == hospital* ]] || [[ "$f" == practitioner* ]]; then
    continue
  fi

  curl -X POST http://localhost:8080/fhir \
    -H "Content-Type: application/fhir+json" \
    -d @"$f"

  count=$((count + 1))

  if [ $count -eq 3 ]; then
    break
  fi
done

echo "Uploaded $count patients"
```

Verify if the patient bundles were loaded:

```bash
curl -s "http://localhost:8080/fhir/Patient?_format=json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'Total patients: {data.get(\"total\", 0)}')
for entry in data.get('entry', []):
    r = entry['resource']
    name = r.get('name', [{}])[0]
    first = ' '.join(name.get('given', []))
    last = name.get('family', '')
    print(f'  ID: {r[\"id\"]}  Name: {first} {last}')
"
```

### Start the backend server
```bash
cd server
npm run dev
```
The server will start at http://localhost:3000

### Start the frontend
```bash
cd client
npm run dev
```
The frontend will start at http://localhost:5137

| Method | Endpoint            | Description                                      | Auth Required |
|--------|---------------------|--------------------------------------------------|---------------|
| POST   | /auth/register      | Register a new user                              | No            |
| POST   | /auth/login         | Login and receive JWT token                      | No            |
| GET    | /me                 | Get current logged-in user profile               | Yes           |
| GET    | /meal-logs          | Retrieve all meal logs for the logged-in user    | Yes           |
| POST   | /meal-logs          | Create a new meal log with food items            | Yes           |
| GET    | /fhir/search        | Search FHIR patients by name query               | No            |
| POST   | /fhir/link          | Link a FHIR patient ID to the logged-in user     | Yes           |
| GET    | /fhir/patient/:id   | Retrieve full FHIR patient details by ID         | No            |


### Example Requests

**Register a user**
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "firstName": "Jane",
    "lastName": "Doe"
  }'
```

**Login**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

**Get current user (protected)**
```bash
curl -X GET http://localhost:3000/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## FHIR Integration

Users can link a FHIR patient to their account. The patient ID is stored in the database and used to fetch patient details from the FHIR server.

## Troubleshooting
**NOTE: THIS IS UNTESTED**

If FHIR patient shows "N/A":
- Ensure a patient is linked via /fhir/link
- Check database for fhirPatientId
- Ensure HAPI FHIR server is running at http://localhost:8080
