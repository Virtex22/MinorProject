const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// MySQL Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '23211A6727@bvrit',
    database: process.env.DB_NAME || 'hackthon',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware to handle database connections
const withConnection = async (callback) => {
    let connection;
    try {
        connection = await pool.getConnection();
        return await callback(connection);
    } catch (error) {
        console.error('Database error:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
};

// Validation Helpers
const validateTask = (task) => {
    const errors = [];
    
    if (!task.name) errors.push('Task name is required');
    if (!task.type) errors.push('Task type is required');
    
    return errors;
};

// Routes

// Get Tasks Route (Enhanced Filtering)
app.get('/getTasks', async (req, res) => {
    try {
        const { filter = 'All', sortBy = 'date', order = 'ASC' } = req.query;

        const result = await withConnection(async (connection) => {
            let query = `
                SELECT 
                    id, 
                    name, 
                    type, 
                    isDaily, 
                    reminderTime, 
                    date, 
                    time, 
                    status, 
                    isCompleted, 
                    priority,
                    createdAt
                FROM tasks
                WHERE 1=1
            `;
            const queryParams = [];

            // Filtering logic based on the requested filter
            switch(filter) {
                case 'Completed':
                    query += ' AND (status = ? OR isCompleted = ?)';
                    queryParams.push('Completed', 1);
                    break;
                case 'Urgent':
                    query += ` AND (
                        (date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 DAY)) 
                        OR (isDaily = 1 AND reminderTime IS NOT NULL)
                        OR (status != ? OR status IS NULL))`;
                        queryParams.push('Completed');
                        break;
                case 'Activity':
                    query += ' AND (status != ? OR status IS NULL)';
                    queryParams.push('Completed');
                    break;
                case 'All':
                default:
                    // No additional filtering for 'All'
                    break;
            }

            // Sorting
            const validSortColumns = ['date', 'name', 'type', 'reminderTime', 'createdAt'];
            if (validSortColumns.includes(sortBy)) {
                query += ` ORDER BY ${sortBy} ${order === 'DESC' ? 'DESC' : 'ASC'}`;
            }

            const [rows] = await connection.query(query, queryParams);
            return rows;
        });

        res.status(200).json(result);
    } catch (error) {
        console.error('Error retrieving tasks:', error);
        res.status(500).json({ 
            message: 'Failed to retrieve tasks', 
            error: error.message 
        });
    }
});

// Add Task Route
app.post('/addTask', async (req, res) => {
    try {
        const taskData = req.body;
        
        // Validate task
        const validationErrors = validateTask(taskData);
        if (validationErrors.length > 0) {
            return res.status(400).json({ 
                message: 'Validation failed', 
                errors: validationErrors 
            });
        }

        const result = await withConnection(async (connection) => {
            // Check for duplicate task
            const [existingTasks] = await connection.query(
                'SELECT COUNT(*) AS count FROM tasks WHERE name = ? AND type = ?', 
                [taskData.name, taskData.type]
            );

            if (existingTasks[0].count > 0) {
                throw new Error('Similar task already exists');
            }

            // Prepare task insert data
            const insertData = {
                name: taskData.name,
                type: taskData.type,
                isDaily: taskData.isDaily ? 1 : 0,
                reminderTime: taskData.isDaily ? taskData.reminderTime : null,
                date: !taskData.isDaily ? taskData.date : null,
                time: !taskData.isDaily ? taskData.time : null,
                status: 'Active',
                isCompleted: 0,
                priority: taskData.priority || 'Normal',
                createdAt: new Date()
            };

            // Insert task
            const [insertResult] = await connection.query(
                'INSERT INTO tasks SET ?', 
                insertData
            );

            return insertResult;
        });

        res.status(201).json({
            message: 'Task added successfully!',
            taskId: result.insertId
        });
    } catch (error) {
        console.error('Error adding task:', error);
        
        // Differentiate between validation and other errors
        if (error.message === 'Similar task already exists') {
            return res.status(409).json({ message: error.message });
        }

        res.status(500).json({ 
            message: 'Failed to add task', 
            error: error.message 
        });
    }
});

// Toggle Task Status Route
app.patch('/tasks/:id/toggle-status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        // Validate status
        const validStatuses = ['Active', 'Completed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const result = await withConnection(async (connection) => {
            // Update task status
            const [updateResult] = await connection.query(
                `UPDATE tasks 
                SET 
                    status = ?, 
                    isCompleted = ?,
                    completedAt = ${status === 'Completed' ? 'NOW()' : 'NULL'}
                WHERE id = ?`, 
                [
                    status, 
                    status === 'Completed' ? 1 : 0, 
                    id
                ]
            );

            // Check if task was actually updated
            if (updateResult.affectedRows === 0) {
                throw new Error('Task not found');
            }

            return updateResult;
        });

        res.status(200).json({ 
            message: 'Task status updated successfully', 
            taskId: id, 
            status 
        });
    } catch (error) {
        console.error('Error updating task status:', error);
        
        if (error.message === 'Task not found') {
            return res.status(404).json({ message: error.message });
        }

        res.status(500).json({ 
            message: 'Failed to update task status', 
            error: error.message 
        });
    }
});

// Delete Task Route
app.delete('/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await withConnection(async (connection) => {
            const [deleteResult] = await connection.query(
                'DELETE FROM tasks WHERE id = ?', 
                [id]
            );

            if (deleteResult.affectedRows === 0) {
                throw new Error('Task not found');
            }

            return deleteResult;
        });

        res.status(200).json({ 
            message: 'Task deleted successfully', 
            taskId: id 
        });
    } catch (error) {
        console.error('Error deleting task:', error);
        
        if (error.message === 'Task not found') {
            return res.status(404).json({ message: error.message });
        }

        res.status(500).json({ 
            message: 'Failed to delete task', 
            error: error.message 
        });
    }
});

// Database Initialization Route
app.get('/init-db', async (req, res) => {
    try {
        await withConnection(async (connection) => {
            // Create tasks table if not exists
            await connection.query(`
                CREATE TABLE IF NOT EXISTS tasks (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    type ENUM('Work', 'Personal', 'Urgent', 'Occasional') NOT NULL,
                    isDaily BOOLEAN DEFAULT FALSE,
                    reminderTime TIME,
                    date DATE,
                    time TIME,
                    status ENUM('Active', 'Completed') DEFAULT 'Active',
                    isCompleted BOOLEAN DEFAULT FALSE,
                    priority ENUM('Low', 'Normal', 'High') DEFAULT 'Normal',
                    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completedAt TIMESTAMP NULL
                )
            `);
        });

        res.status(200).json({ message: 'Database initialized successfully' });
    } catch (error) {
        console.error('Database initialization error:', error);
        res.status(500).json({ 
            message: 'Failed to initialize database', 
            error: error.message 
        });
    }
});

// Server Startup
const startServer = async () => {
    try {
        // Test database connection
        await pool.getConnection();
        console.log('Database connection established');

        // Start Express server
        app.listen(port, () => {
            console.log(`Task Manager Backend running on http://localhost:${port}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

// Graceful Shutdown
process.on('SIGINT', async () => {
    try {
        await pool.end();
        console.log('MySQL connection pool closed');
        process.exit(0);
    } catch (error) {
        console.error('Error closing connection pool:', error);
        process.exit(1);
    }
});

// Initialize Server
startServer();

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        message: 'Something went wrong!',
        error: process.env.NODE_ENV === 'production' ? {} : err.stack
    });
});

module.exports = app;