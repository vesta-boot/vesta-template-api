import { NextFunction, Request, Response, Router } from "express";
import { IRole } from "../cmn/models/Role";
import { IUser, SourceApp, User, UserType } from "../cmn/models/User";
import { Acl } from "../helpers/Acl";
import { IServerAppConfig } from "../helpers/Config";
import { LoggerFunction } from "../helpers/Logger";
import { Database, Err, IModel, IQueryOption, IQueryRequest, KeyValueDatabase, ValidationError, Vql } from "../medium";
import { Session } from "../session/Session";

export interface IExtRequest extends Request {
    log: LoggerFunction;
    session: Session;
    sessionDB: KeyValueDatabase;
}

export abstract class BaseController {
    protected MAX_FETCH_COUNT = 50;

    constructor(protected config: IServerAppConfig, protected acl: Acl, protected database: Database) {
        this.init();
    }

    public abstract route(router: Router): void;

    /**
     * This function is called when after a controller is instantiated and the route method is called.
     * Controller instantiation > init method > route method > resolve method
     * The instantiation of other controllers will happen in order and won't wait for this method's termination.
     * However, the next step in application initiation will pause until all promisses from all controllers
     * are resolved. If any of controllers reject their promises, the application won't start.
     *
     *
     * @returns {Promise<boolean>}
     */
    public resolve(): Promise<boolean> {
        return null;
    }

    /**
     * This function is called when a controller is instantiated within constructor method
     * The result of this function is not important.
     * Is an asynchronous operation is going to happen here, the execution process will not wait for it's termination.
     */
    protected init() {
        // tslint
    }

    protected getUserFromSession(req: IExtRequest): User {
        let user = req.session.get<IUser>("user");
        user = user || { role: { name: this.config.security.guestRoleName } } as IUser;
        // getting user sourceApp from POST/PUT body or GET/DELETE query
        user.sourceApp = +(req.body.s || req.query.s);
        return new User(user);
    }

    protected isAdmin(user: User): boolean {
        try {
            return user.isOfType(UserType.Admin) && user.sourceApp === SourceApp.Panel;
        } catch (e) {
            return false;
        }
    }

    /**
     * This method returns a middleware that checks the user access to specific (resource, action) whenever a request
     *  is made from a user.
     * It also adds (resource, action) to the resourceList at server init time.
     */
    protected checkAcl(resource: string, action: string) {
        this.acl.addResource(resource, action);
        return (req: IExtRequest, res: Response, next: NextFunction) => {
            if (req.session) {
                const user: IUser = this.getUserFromSession(req);
                if (this.acl.isAllowed((user.role as IRole).name, resource, action)) {
                    return next();
                }
            }
            next(new Err(Err.Code.Forbidden));
        };
    }

    protected retrieveId(req: IExtRequest): number {
        const id = +req.params.id;
        if (isNaN(id)) {
            throw new ValidationError({ id: "type" });
        }
        return id;
    }

    protected query2vql<T>(modelClass: IModel, req: IQueryRequest<T>, isCounting?: boolean, isSearch?: boolean): Vql {
        const fields = [];
        if (req.query) {
            for (let fieldNames = modelClass.schema.getFieldsNames(), i = fieldNames.length; i--;) {
                if (fieldNames[i] in req.query) {
                    fields.push(fieldNames[i]);
                }
            }
        }
        const query = new Vql(modelClass.schema.name);
        if (req.fields && req.fields.length) {
            query.select(...req.fields);
        }
        if (fields.length) {
            const model = new modelClass(req.query);
            const validationError = model.validate(...fields);
            if (validationError) {
                throw new ValidationError(validationError);
            }
            isSearch ? query.search(req.query, modelClass) : query.filter(req.query);
        }
        if (!isCounting) {
            if (req.relations) {
                query.fetchRecordFor(...req.relations);
            }
            const limit = +req.limit;
            query.limitTo(Math.min(!isNaN(limit) && limit > 0 ? limit : this.MAX_FETCH_COUNT, this.MAX_FETCH_COUNT));
            const page = +req.page;
            query.fromPage(!isNaN(page) && page > 0 ? page : 1);
            if (req.orderBy && req.orderBy.length) {
                const orderBy = req.orderBy;
                for (let i = 0, il = req.orderBy.length; i < il; ++i) {
                    query.sortBy(orderBy[i].field, orderBy[i].ascending);
                }
            }
        }
        return query;
    }

    protected parseQuery<T>(modelClass: IModel, req: IQueryRequest<T>): IQueryOption {
        const query: IQueryOption = {};
        const fields = [];
        if (req.query) {
            for (let fieldNames = modelClass.schema.getFieldsNames(), i = fieldNames.length; i--;) {
                if (fieldNames[i] in req.query) {
                    fields.push(fieldNames[i]);
                }
            }
        }
        if (fields.length) {
            const model = new modelClass(req.query);
            const validationError = model.validate(...fields);
            if (validationError) {
                throw new ValidationError(validationError);
            }
            query.fields = fields;
        }
        const limit = +req.limit;
        query.limit = Math.min(!isNaN(limit) && limit > 0 ? limit : this.MAX_FETCH_COUNT, this.MAX_FETCH_COUNT);
        const page = +req.page;
        query.page = !isNaN(page) && page > 0 ? page : 1;
        if (req.orderBy && req.orderBy.length) {
            const orderBy = req.orderBy;
            query.orderBy = [];
            for (let i = 0, il = req.orderBy.length; i < il; ++i) {
                query.orderBy.push({ field: orderBy[i].field, ascending: orderBy[i].ascending });
            }
        }
        return query;
    }

    protected wrap(action: (req: IExtRequest, res: Response, next: NextFunction) => any) {
        action = action.bind(this);
        return async (req, res, next) => {
            try {
                await action(req, res, next);
            } catch (error) {
                next(error);
            }
        };
    }
}
