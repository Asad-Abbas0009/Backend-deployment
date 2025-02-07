const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise.js');
const multer = require("multer");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const socketIo = require('socket.io');
const http = require('http');
require('dotenv').config();
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });


app.use(cors());
app.use(bodyParser.json());

const allowedOrigins = [
  'http://localhost:3000', // ✅ Allow React frontend during development
  'https://onesimulation-frontend.s3.ap-south-1.amazonaws.com', // ✅ AWS S3 Frontend URL
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // ✅ IMPORTANT for authentication (JWT, cookies)
}));


// Configure MySQL connection
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});



pool.getConnection()
  .then((conn) => {
    console.log("Connected to the database successfully!");
    conn.release();
  })
  .catch((err) => {
    console.error("Database connection error:", err.message);
  });
  module.exports = pool;

// Debugging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`, req.body);
  next();
});


app.get('/api/students', async (req, res) => {
  try {
    const query = `SELECT id, name, email FROM users WHERE role = 'student'`;
    const [results] = await pool.query(query);  // Use await to handle promise-based query

    res.status(200).json(results);
  } catch (err) {
    console.error('Error fetching students:', err.message);
    res.status(500).json({ error: 'Failed to fetch students.' });
  }
});


// **2. Fetch Cases**
app.get('/api/cases', (req, res) => {
  const query = `SELECT * FROM cases`; // Replace with your actual table name
  pool.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching cases:', err);
      res.status(500).json({ error: 'Failed to fetch cases.' });
      return;
    }
    res.json(results);
  });
});


app.post('/api/assign-case', (req, res) => {
  const { caseKey, title, scenarios, questions, assignedStudents } = req.body;

  if (!caseKey || !title || !scenarios || !questions || !assignedStudents || assignedStudents.length === 0) {
    return res.status(400).json({
      error: 'Invalid payload. Case ID, title, scenarios, questions, and assigned students are required.',
    });
  }

  const newActivity = {
    type: 'assignment',
    caseKey: caseKey || 'N/A',
    title: title || 'Unknown Title',
    assignedStudents: assignedStudents.length ? assignedStudents : [],
    timestamp: new Date().toLocaleTimeString(),
  };

  console.log('Broadcasting new activity:', newActivity);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(newActivity));
    }
  });

  res.status(200).json({ message: 'Case assigned successfully!', newActivity });
});


app.get('/api/student-assignments/:studentName', async (req, res) => {
  const { studentName } = req.params;

  if (!studentName) {
    return res.status(400).json({ error: "Student name is required." });
  }

  try {
    const [results] = await pool.query(
      `SELECT case_id, title, scenarios, questions, assigned_at FROM case_assignments WHERE student_name = ?`,
      [studentName]
    );

    if (results.length === 0) {
      return res.status(404).json({ message: "No assignments found for this student." });
    }

    // Safely process each assignment result
    const assignments = results.map((assignment) => {
      let scenarios, questions;

      try {
        scenarios = JSON.parse(assignment.scenarios);
      } catch (err) {
        console.warn("Error parsing scenarios, returning as raw:", assignment.scenarios);
        scenarios = assignment.scenarios;
      }

      try {
        questions = JSON.parse(assignment.questions);
      } catch (err) {
        console.warn("Error parsing questions, returning as raw:", assignment.questions);
        questions = assignment.questions;
      }

      return {
        caseId: assignment.case_id,
        title: assignment.title,
        scenarios: Array.isArray(scenarios) ? scenarios : [],
        questions: Array.isArray(questions) ? questions : [],
        assignedAt: assignment.assigned_at,
      };
    });

    res.status(200).json(assignments);
  } catch (err) {
    console.error("Error fetching assignments:", err.message);
    res.status(500).json({ error: "Failed to fetch assignments." });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password, role } = req.body;

  try {
    const query = `SELECT * FROM users WHERE email = ? AND role = ?`;
    const [results] = await pool.query(query, [email, role]);

    if (results.length > 0) {
      const user = results[0];

      // Compare the entered password with the hashed password stored in the database
      const isMatch = await bcrypt.compare(password, user.password);

      if (isMatch) {
        res.status(200).json({
          message: 'Login successful',
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          },
        });
      } else {
        res.status(401).json({ error: 'Invalid email or password.' });
      }
    } else {
      res.status(404).json({ error: 'User not found.' });
    }
  } catch (err) {
    console.error('Database query error:', err.message);
    res.status(500).json({ error: 'Database error occurred.' });
  }
});

app.post('/api/signup', async (req, res) => {
  const { name, email, password, role } = req.body;

  try {
    // Check if the user already exists
    const [existingUsers] = await pool.query(`SELECT * FROM users WHERE email = ?`, [email]);

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'User already exists with this email.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user into the database
    const insertQuery = `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`;
    await pool.query(insertQuery, [name, email, hashedPassword, role]);

    res.status(201).json({ message: 'User created successfully!' });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});



app.post('/api/patients', async (req, res) => {
  const {
    caseId, registration_id, name, age, gender, contact, email, address, medicalHistory,
    allergies, bloodGroup, emergencyContact, dateOfAdmission, height, weight,
    temperature, bloodPressure, pulseRate, respiratoryRate, spO2
  } = req.body;

  // Validation
  if (!caseId || !registration_id || !name || !age || !gender || !contact) {
    return res.status(400).json({ error: 'Required fields are missing.' });
  }

  const query = `
    INSERT INTO patients (
      caseId, registration_id, name, age, gender, contact, email, address, medicalHistory,
      allergies, bloodGroup, emergencyContact, dateOfAdmission, height, weight,
      temperature, bloodPressure, pulseRate, respiratoryRate, spO2
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const values = [
    caseId, registration_id, name, age, gender, contact, email || null, address || null, 
    medicalHistory || null, allergies || null, bloodGroup || null, emergencyContact || null, 
    dateOfAdmission || null, height || null, weight || null, temperature || null, 
    bloodPressure || null, pulseRate || null, respiratoryRate || null, spO2 || null
  ];

  try {
    const [result] = await pool.query(query, values);
    res.status(201).json({
      message: 'Patient registered successfully!',
      insertedId: result.insertId,
    });
  } catch (error) {
    console.error('Error inserting patient record:', error.message);
    res.status(500).json({ error: 'Failed to register patient. Please try again.' });
  }
});



app.post('/api/submit-answers', (req, res) => {
  const { studentName, caseId, answers } = req.body;

  // Validate the payload
  if (!studentName || !caseId || !answers || Object.keys(answers).length === 0) {
    return res.status(400).json({ error: 'Invalid payload. All fields are required.' });
  }

  // Convert answers object into an array
  const answersArray = Object.entries(answers).map(([questionId, answer]) => ({
    questionId,
    answer,
  }));

  const query = `
    INSERT INTO student_answers (student_name, case_id, question_id, answer, submitted_at)
    VALUES (?, ?, ?, ?, NOW())
  `;

  // Insert each answer into the database
  const promises = answersArray.map(({ questionId, answer }) =>
    new Promise((resolve, reject) => {
      pool.query(query, [studentName, caseId, questionId, answer], (err) => {
        if (err) {
          console.error('Error saving answer:', err);
          return reject(err);
        }
        resolve();
      });
    })
  );

  // Handle the database insert operations
  Promise.all(promises)
    .then(() => res.status(200).json({ message: 'Answers submitted successfully!' }))
    .catch((error) => {
      console.error('Error saving answers:', error);
      res.status(500).json({ error: 'Failed to save answers. Please try again.' });
    });
});

const upload = multer({ dest: "uploads/" });

app.post("/process", upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        console.log("Uploaded file details:", file);

        // Prepare form-data for Python backend
        const formData = new FormData();
        formData.append("file", fs.createReadStream(file.path));

        // Send the file to Python backend
        const response = await axios.post("http://localhost:8000/compare", formData, {
            headers: formData.getHeaders(),
        });

        // Respond with Python backend response
        res.status(200).json(response.data);
    } catch (error) {
        console.error("Error in Node.js backend:", error.message);
        console.error("Details:", error.response?.data || {});
        res.status(500).json({ error: error.message, details: error.response?.data || {} });
    } finally {
        // Clean up the file after sending it to Python backend
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }
    }
});

app.post('/register', (req, res) => {
  const data = req.body;

  const sql = `
    INSERT INTO patients (
      caseId, registration_id, name, age, gender, contact, email, address,
      medicalHistory, allergies, bloodGroup, emergencyContact, dateOfAdmission,
      height, weight, temperature, bloodPressure, pulseRate, respiratoryRate, spO2
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  pool.query(sql, Object.values(data), (err) => {
    if (err) {
      console.error('Error saving patient:', err);
      return res.status(500).json({ message: 'Error saving patient data' });
    }
    res.status(200).json({ message: 'Patient registered successfully' });
  });
});

app.get("/api/patients", (req, res) => {
  const { studentName, caseId } = req.query;
  let query = "SELECT * FROM patients WHERE 1=1";
  const queryParams = [];

  if (studentName) {
      query += " AND name LIKE ?";
      queryParams.push(`%${studentName}%`);
  }

  if (caseId) {
      query += " AND case_id = ?";
      queryParams.push(caseId);
  }

  pool.query(query, queryParams, (err, results) => {
      if (err) {
          console.error("Error fetching patients:", err);
          res.status(500).json({ error: "Failed to fetch patients." });
      } else {
          res.json(results);
      }
  });
});
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`, req.body);
  next();
});

app.get('/api/teacher-data', async (req, res) => {
  const { studentName, caseId } = req.query;

  let query = `
      SELECT 
          u.name AS student_name,
          u.email AS student_email,
          ca.title AS case_title,
          ca.scenarios AS case_scenarios,
          ca.questions AS case_questions,
          p.name AS patient_name,
          p.age AS patient_age,
          p.gender AS patient_gender,
          p.contact AS patient_contact,
          p.medicalHistory AS patient_medical_history, 
          p.allergies AS patient_allergies,
          p.bloodGroup AS patient_blood_group
      FROM users u
      INNER JOIN case_assignments ca ON u.name = ca.student_name
      INNER JOIN patients p ON p.caseId = ca.case_id
      WHERE 1=1
  `;
  const params = [];

  if (studentName) {
      query += " AND u.name LIKE ?";
      params.push(`%${studentName}%`);
  }
  if (caseId) {
      query += " AND ca.case_id = ?";
      params.push(caseId);
  }

  try {
      const [results] = await pool.query(query, params);
      res.json(results);
  } catch (err) {
      console.error('Error fetching case details:', err.message);
      res.status(500).json({ error: 'Failed to fetch case details.' });
  }
});


app.get('/api/student-assignments/:studentName', async (req, res) => {
  const { studentName } = req.params;

  const query = `
      SELECT case_id, title, scenarios, questions, assigned_at
      FROM case_assignment
      WHERE student_name = ?
  `;

  try {
      const [results] = await pool.query(query, [studentName]);
      res.json(results);
  } catch (err) {
      console.error('Error fetching cases:', err.message);
      res.status(500).json({ error: 'Failed to fetch cases.' });
  }
});




const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  
  console.log(`Server running on http://localhost:${PORT}`);
});

