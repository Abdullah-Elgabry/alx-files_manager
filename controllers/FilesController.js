/* eslint-disable import/no-named-as-default */
/* eslint-disable no-unused-vars */
import { tmpdir } from 'os';
import { promisify } from 'util';
import Queue from 'bull/lib/queue';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, writeFile, stat, existsSync, realpath } from 'fs';
import { join as joinPath } from 'path';
import { Request, Response } from 'express';
import { contentType } from 'mime-types';
import mongoDBCore from 'mongodb/lib/core';
import dbClient from '../utils/db';
import { getUserFromXToken } from '../utils/auth';

// Constants used in this file
const VALID_FILE_TYPES = {
  folder: 'folder',
  file: 'file',
  image: 'image',
};

const ROOT_FOLDER_ID = 0;
const DEFAULT_ROOT_FOLDER = 'files_manager';
const MAX_FILES_PER_PAGE = 20;
const NULL_ID = Buffer.alloc(24, '0').toString('utf-8');

const mkDirAsync = promisify(mkdir);
const writeFileAsync = promisify(writeFile);
const statAsync = promisify(stat);
const realpathAsync = promisify(realpath);
const fileQueue = new Queue('thumbnail generation');

// Function to validate if a given ID is valid
const isValidId = (id) => {
  const size = 24;
  if (typeof id !== 'string' || id.length !== size) {
    return false;
  }

  const charRanges = [
    [48, 57],  // 0-9
    [97, 102], // a-f
    [65, 70],  // A-F
  ];

  for (let i = 0; i < size; i++) {
    const code = id.charCodeAt(i);
    if (!charRanges.some(range => code >= range[0] && code <= range[1])) {
      return false;
    }
  }
  return true;
};

export default class FilesController {
  /**
   * Handles file upload, including saving the file and its metadata.
   * @param {Request} req The request object containing file details.
   * @param {Response} res The response object for sending upload status.
   */
  static async postUpload(req, res) {
    const { user } = req;
    const name = req.body?.name;
    const type = req.body?.type;
    const parentId = req.body?.parentId || ROOT_FOLDER_ID;
    const isPublic = req.body?.isPublic || false;
    const base64Data = req.body?.data || '';

    if (!name) {
      return res.status(400).json({ error: 'Missing name' });
    }
    if (!type || !Object.values(VALID_FILE_TYPES).includes(type)) {
      return res.status(400).json({ error: 'Missing type' });
    }
    if (!req.body.data && type !== VALID_FILE_TYPES.folder) {
      return res.status(400).json({ error: 'Missing data' });
    }
    if ((parentId !== ROOT_FOLDER_ID) && (parentId !== ROOT_FOLDER_ID.toString())) {
      const file = await (await dbClient.filesCollection())
        .findOne({
          _id: new mongoDBCore.BSON.ObjectId(isValidId(parentId) ? parentId : NULL_ID),
        });

      if (!file) {
        return res.status(400).json({ error: 'Parent not found' });
      }
      if (file.type !== VALID_FILE_TYPES.folder) {
        return res.status(400).json({ error: 'Parent is not a folder' });
      }
    }

    const userId = user._id.toString();
    const baseDir = `${process.env.FOLDER_PATH || ''}`.trim().length > 0
      ? process.env.FOLDER_PATH.trim()
      : joinPath(tmpdir(), DEFAULT_ROOT_FOLDER);

    const newFile = {
      userId: new mongoDBCore.BSON.ObjectId(userId),
      name,
      type,
      isPublic,
      parentId: (parentId === ROOT_FOLDER_ID) || (parentId === ROOT_FOLDER_ID.toString())
        ? '0'
        : new mongoDBCore.BSON.ObjectId(parentId),
    };

    await mkDirAsync(baseDir, { recursive: true });

    if (type !== VALID_FILE_TYPES.folder) {
      const localPath = joinPath(baseDir, uuidv4());
      await writeFileAsync(localPath, Buffer.from(base64Data, 'base64'));
      newFile.localPath = localPath;
    }

    const insertionInfo = await (await dbClient.filesCollection())
      .insertOne(newFile);
    
    const fileId = insertionInfo.insertedId.toString();
    if (type === VALID_FILE_TYPES.image) {
      const jobName = `Image thumbnail [${userId}-${fileId}]`;
      fileQueue.add({ userId, fileId, name: jobName });
    }

    return res.status(201).json({
      id: fileId,
      userId,
      name,
      type,
      isPublic,
      parentId: (parentId === ROOT_FOLDER_ID) || (parentId === ROOT_FOLDER_ID.toString())
        ? 0
        : parentId,
    });
  }

  /**
   * Retrieves details of a specific file by its ID.
   * @param {Request} req The request object containing the file ID.
   * @param {Response} res The response object to return file details.
   */
  static async getShow(req, res) {
    const { user } = req;
    const id = req.params?.id || NULL_ID;
    const userId = user._id.toString();

    const file = await (await dbClient.filesCollection())
      .findOne({
        _id: new mongoDBCore.BSON.ObjectId(isValidId(id) ? id : NULL_ID),
        userId: new mongoDBCore.BSON.ObjectId(isValidId(userId) ? userId : NULL_ID),
      });

    if (!file) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.status(200).json({
      id,
      userId,
      name: file.name,
      type: file.type,
      isPublic: file.isPublic,
      parentId: file.parentId === ROOT_FOLDER_ID.toString()
        ? 0
        : file.parentId.toString(),
    });
  }

  /**
   * Retrieves a list of files for a user, with pagination support.
   * @param {Request} req The request object containing pagination and parentId info.
   * @param {Response} res The response object to return the list of files.
   */
  static async getIndex(req, res) {
    const { user } = req;
    const parentId = req.query.parentId || ROOT_FOLDER_ID.toString();
    const page = /\d+/.test((req.query.page || '').toString())
      ? Number.parseInt(req.query.page, 10)
      : 0;

    const filesFilter = {
      userId: user._id,
      parentId: parentId === ROOT_FOLDER_ID.toString()
        ? parentId
        : new mongoDBCore.BSON.ObjectId(isValidId(parentId) ? parentId : NULL_ID),
    };

    const files = await (await (await dbClient.filesCollection())
      .aggregate([
        { $match: filesFilter },
        { $sort: { _id: -1 } },
        { $skip: page * MAX_FILES_PER_PAGE },
        { $limit: MAX_FILES_PER_PAGE },
        {
          $project: {
            _id: 0,
            id: '$_id',
            userId: '$userId',
            name: '$name',
            type: '$type',
            isPublic: '$isPublic',
            parentId: {
              $cond: { if: { $eq: ['$parentId', '0'] }, then: 0, else: '$parentId' },
            },
          },
        },
      ])).toArray();

    return res.status(200).json(files);
  }

  /**
   * Publishes a file, making it publicly accessible.
   * @param {Request} req The request object containing the file ID.
   * @param {Response} res The response object to confirm the file is now public.
   */
  static async putPublish(req, res) {
    const { user } = req;
    const { id } = req.params;
    const userId = user._id.toString();

    const fileFilter = {
      _id: new mongoDBCore.BSON.ObjectId(isValidId(id) ? id : NULL_ID),
      userId: new mongoDBCore.BSON.ObjectId(isValidId(userId) ? userId : NULL_ID),
    };

    const file = await (await dbClient.filesCollection())
      .findOne(fileFilter);

    if (!file) {
      return res.status(404).json({ error: 'Not found' });
    }

    await (await dbClient.filesCollection())
      .updateOne(fileFilter, { $set: { isPublic: true } });

    return res.status(200).json({
      id,
      userId,
      name: file.name,
      type: file.type,
      isPublic: true,
      parentId: file.parentId === ROOT_FOLDER_ID.toString()
        ? 0
        : file.parentId.toString(),
    });
  }

  /**
   * Revokes public access to a file, making it private.
   * @param {Request} req The request object containing the file ID.
   * @param {Response} res The response object to confirm the file is no longer public.
   */
  static async putUnpublish(req, res) {
    const { user } = req;
    const { id } = req.params;
    const userId = user._id.toString();

    const fileFilter = {
      _id: new mongoDBCore.BSON.ObjectId(isValidId(id) ? id : NULL_ID),
      userId: new mongoDBCore.BSON.ObjectId(isValidId(userId) ? userId : NULL_ID),
    };

    const file = await (await dbClient.filesCollection())
      .findOne(fileFilter);

    if (!file) {
      return res.status(404).json({ error: 'Not found' });
    }

    await (await dbClient.filesCollection())
      .updateOne(fileFilter, { $set: { isPublic: false } });

    return res.status(200).json({
      id,
      userId,
      name: file.name,
      type: file.type,
      isPublic: false,
      parentId: file.parentId === ROOT_FOLDER_ID.toString()
        ? 0
        : file.parentId.toString(),
    });
  }

  /**
   * Retrieves file content by ID, with options to stream or download.
   * @param {Request} req The request object containing the file ID.
   * @param {Response} res The response object to return the file content.
   */
  static async getFile(req, res) {
    const { user } = req;
    const { id } = req.params;
    const sizeOptions = req.query.size || null;
    const userId = user._id ? user._id.toString() : '';

    const fileFilter = {
      _id: new mongoDBCore.BSON.ObjectId(isValidId(id) ? id : NULL_ID),
    };

    const file = await (await dbClient.filesCollection())
      .findOne(fileFilter);

    if (!file || (!file.isPublic && (file.userId.toString() !== userId))) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (file.type === VALID_FILE_TYPES.folder) {
      return res.status(400).json({ error: 'A folder doesn\'t have content' });
    }

    let filePath = file.localPath;

    if (sizeOptions) {
      filePath = `${file.localPath}_${sizeOptions}`;
    }

    if (existsSync(filePath)) {
      const fileInfo = await statAsync(filePath);
      const mimeType = contentType(file.name) || 'text/plain';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', fileInfo.size);
      return res.status(200).sendFile(await realpathAsync(filePath));
    }

    return res.status(404).json({ error: 'Not found' });
  }
}
