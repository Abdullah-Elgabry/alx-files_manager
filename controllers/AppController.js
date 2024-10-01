/* eslint-disable import/no-named-as-default */
import redisClient from '../utils/redis';
import dbClient from '../utils/db';

/**
 * The AppController handles requests related to the application's
 * overall status and statistics. It provides two main routes:
 * - `getStatus`: Returns the connection status of Redis and the database.
 * - `getStats`: Returns the number of users and files in the database.
 */
export default class AppController {
  /**
   * Responds with the status of both Redis and the database.
   * @param {Object} req The request object.
   * @param {Object} res The response object.
   */
  static getStatus(req, res) {
    res.status(200).json({
      redis: redisClient.isAlive(),
      db: dbClient.isAlive(),
    });
  }

  /**
   * this will ret a users and files from the database.
   * @param {Object} req The request object.
   * @param {Object} res The response object.
   */
  static getStats(req, res) {
    Promise.all([dbClient.nbUsers(), dbClient.nbFiles()])
      .then(([usersCount, filesCount]) => {
        res.status(200).json({ users: usersCount, files: filesCount });
      });
  }
}
