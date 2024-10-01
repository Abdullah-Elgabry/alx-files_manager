/* eslint-disable import/no-named-as-default */
import { v4 as uuidv4 } from 'uuid';
import redisClient from '../utils/redis';

/**
 * The AuthController manages user authentication, handling
 * connection and disconnection processes.
 */

export default class AuthController {
  /**
   * Logs the user in by generating an authentication token
   * and storing it in Redis with a 24-hour expiration.
   * @param {Request} req The request object containing the authenticated user's data.
   * @param {Response} res The response object used to return the authentication token.
   * @returns {void}
   */
  static async getConnect(req, res) {
    const { user } = req;
    const token = uuidv4();

    await redisClient.set(`auth_${token}`, user._id.toString(), 24 * 60 * 60);
    res.status(200).json({ token });
  }

  /**
   * Logs the user out by deleting the authentication token from Redis.
   * @param {Request} req The request object, including the token in the headers.
   * @param {Response} res The response object for sending the logout status.
   * @returns {void}
   */
  static async getDisconnect(req, res) {
    const token = req.headers['x-token'];

    await redisClient.del(`auth_${token}`);
    res.status(204).send();
  }
}
